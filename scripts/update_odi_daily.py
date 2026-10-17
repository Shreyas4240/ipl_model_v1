"""
Daily ODI data/model updater. Independent of update_ipl_daily.py.

1) Downloads latest odis_json.zip from Cricsheet (optional --skip-download).
2) Merges new/updated match JSON files into odis_json/.
3) Rebuilds odi_innings_snapshots.csv (men's ODIs, 2023+).
4) Refits RR shrinkage and resource-v2 params for 50-over phases.
5) Writes data/odi_model_params.json.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from process_odi_data import extract_innings_snapshots_from_odis

CRICSHEET_ODI_ZIP = "https://cricsheet.org/downloads/odis_json.zip"
JSON_DIR = "odis_json"
MODEL_PARAMS_PATH = os.path.join("data", "odi_model_params.json")
CSV_PATH = "odi_innings_snapshots.csv"
MIN_YEAR = 2023
MAX_OVERS = 50
MAX_WICKETS = 10
PHASE_BOUNDARIES = (10.0, 40.0)


def _download_zip_bytes(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "odi-model-updater/1.0"})
    with urlopen(req, timeout=180) as resp:
        return resp.read()


def _iter_match_json_bytes(zip_bytes: bytes):
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if not name.endswith(".json"):
                continue
            yield os.path.basename(name), zf.read(name)


def _merge_match_jsons(zip_bytes: bytes, json_dir: str) -> dict:
    os.makedirs(json_dir, exist_ok=True)
    added, updated, unchanged = 0, 0, 0
    for fname, data in _iter_match_json_bytes(zip_bytes):
        target = os.path.join(json_dir, fname)
        if not os.path.exists(target):
            with open(target, "wb") as f:
                f.write(data)
            added += 1
            continue
        with open(target, "rb") as f:
            old = f.read()
        if old != data:
            with open(target, "wb") as f:
                f.write(data)
            updated += 1
        else:
            unchanged += 1
    return {"added": added, "updated": updated, "unchanged": unchanged}


def _filter_complete_innings(df: pd.DataFrame) -> pd.DataFrame:
    g = df.groupby(["match_file", "team"])
    last_overs = g["overs_completed"].transform("max")
    last_wickets = g["wickets"].transform("max")
    complete = (last_overs >= MAX_OVERS) | (last_wickets >= MAX_WICKETS)
    return df[complete].copy()


def _phase_index(oc: np.ndarray) -> np.ndarray:
    b0, b1 = PHASE_BOUNDARIES
    return np.where(oc <= b0, 0, np.where(oc <= b1, 1, 2)).astype(int)


def _blended_resource(
    overs_completed: np.ndarray,
    overs_remaining: np.ndarray,
    wickets_remaining: np.ndarray,
    c: np.ndarray,
    b: np.ndarray,
    a: np.ndarray,
    gamma: float,
    blend_overs: float = 1.0,
) -> np.ndarray:
    """Match the resource interpolation used by the runtime ODI predictor."""
    wickets_lost = np.maximum(0.0, MAX_WICKETS - wickets_remaining)

    def phase_resource(k: int) -> np.ndarray:
        return c[k] * (1.0 - np.exp(-b[k] * overs_remaining)) * np.exp(
            -a[k] * np.power(wickets_lost, gamma)
        )

    r0, r1, r2 = phase_resource(0), phase_resource(1), phase_resource(2)
    b0, b1 = PHASE_BOUNDARIES
    resource = np.empty_like(overs_completed, dtype=float)

    early = overs_completed <= b0 - blend_overs
    middle = (overs_completed >= b0 + blend_overs) & (overs_completed <= b1 - blend_overs)
    late = overs_completed >= b1 + blend_overs
    blend0 = ~(early | middle | late) & (overs_completed < b1 - blend_overs)
    blend1 = ~(early | middle | late | blend0)

    resource[early] = r0[early]
    resource[middle] = r1[middle]
    resource[late] = r2[late]
    t0 = (overs_completed[blend0] - (b0 - blend_overs)) / (2.0 * blend_overs)
    resource[blend0] = (1.0 - t0) * r0[blend0] + t0 * r1[blend0]
    t1 = (overs_completed[blend1] - (b1 - blend_overs)) / (2.0 * blend_overs)
    resource[blend1] = (1.0 - t1) * r1[blend1] + t1 * r2[blend1]
    return resource


def _load_training_df(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = _filter_complete_innings(df)
    df = df[(df["final_total"] > 0) & (df["run_rate"] > 0)].copy()
    df["wickets_remaining"] = MAX_WICKETS - df["wickets"]
    df = df[(df["wickets_remaining"] > 0) & (df["overs_remaining"] > 0)]
    return df


def fit_rr_shrinkage(df: pd.DataFrame):
    oc = df["overs_completed"].values.astype(float)
    rr = df["run_rate"].values.astype(float)
    ph = _phase_index(oc)
    gmu = float(np.mean(rr))
    mu_phase = np.array([float(np.mean(rr[ph == k])) if np.any(ph == k) else gmu for k in range(3)])

    phase_z0_a = np.array([[1.40, 0.010], [1.20, 0.008], [1.70, 0.020]], dtype=float)
    z0 = phase_z0_a[ph, 0]
    aa = phase_z0_a[ph, 1]
    curr = df["current_score"].values.astype(float)
    final = df["final_total"].values.astype(float)
    or_rem = df["overs_remaining"].values.astype(float)
    wr = df["wickets_remaining"].values.astype(float)
    mu_row = mu_phase[ph]
    resource = z0 * or_rem * np.exp(-aa * (MAX_WICKETS - wr))

    def mae_vec(x):
        a0, a1, a2 = x
        alpha_row = np.choose(ph, [a0, a1, a2])
        rr_eff = alpha_row * rr + (1.0 - alpha_row) * mu_row
        pred = curr + rr_eff * resource
        return float(np.mean(np.abs(pred - final)))

    res = minimize(mae_vec, x0=[0.20, 0.35, 0.55], bounds=[(0.0, 1.0)] * 3, method="L-BFGS-B")
    return {
        "alpha_by_phase": [float(v) for v in res.x],
        "mu_by_phase": [float(v) for v in mu_phase],
        "mae_objective": float(res.fun),
    }


def fit_resource_v2(df: pd.DataFrame, rr_shrink: dict):
    oc = df["overs_completed"].to_numpy(float)
    orr = df["overs_remaining"].to_numpy(float)
    wr = df["wickets_remaining"].to_numpy(float)
    rr = df["run_rate"].to_numpy(float)
    cur = df["current_score"].to_numpy(float)
    act = df["final_total"].to_numpy(float)
    ph = _phase_index(oc)

    mu = np.array(rr_shrink["mu_by_phase"], dtype=float)

    def unpack(x):
        alpha = np.array(x[0:3], dtype=float)
        c = np.array(x[3:6], dtype=float)
        b = np.array(x[6:9], dtype=float)
        a = np.array(x[9:12], dtype=float)
        g = float(x[12])
        return alpha, c, b, a, g

    def predict_vec(x):
        alpha, c, b, a, g = unpack(x)
        rr_eff = alpha[ph] * rr + (1.0 - alpha[ph]) * mu[ph]
        resource = _blended_resource(oc, orr, wr, c, b, a, g)
        return cur + rr_eff * resource

    def mae_all(x):
        p = predict_vec(x)
        if not np.all(np.isfinite(p)):
            return 1e9
        return float(np.mean(np.abs(p - act)))

    x0 = np.array(
        rr_shrink["alpha_by_phase"] + [
            55.0, 50.0, 40.0, 0.04, 0.035, 0.05, 0.008, 0.004, 0.003, 2.2,
        ],
        dtype=float,
    )
    bounds = [
        (0.0, 1.0), (0.0, 1.0), (0.0, 1.0),
        (10.0, 150.0), (10.0, 150.0), (10.0, 150.0),
        (0.005, 0.35), (0.005, 0.35), (0.005, 0.35),
        (0.0005, 0.25), (0.0005, 0.25), (0.0005, 0.25),
        (1.0, 2.5),
    ]
    res = minimize(mae_all, x0=x0, method="L-BFGS-B", bounds=bounds, options={"maxiter": 800, "ftol": 1e-9})
    alpha, c, b, a, g = unpack(res.x)
    return {
        "alpha_by_phase": [float(v) for v in alpha],
        "phase_params": [
            {"id": "pp1_10", "label": "Overs 1–10", "C": float(c[0]), "b": float(b[0]), "a_w": float(a[0])},
            {"id": "mid11_40", "label": "Overs 11–40", "C": float(c[1]), "b": float(b[1]), "a_w": float(a[1])},
            {"id": "death41_50", "label": "Overs 41–50", "C": float(c[2]), "b": float(b[2]), "a_w": float(a[2])},
        ],
        "wicket_gamma": float(g),
        "phase_blend_overs": 1.0,
        "mae_objective": float(res.fun),
        "optimizer_success": bool(res.success),
    }


def predict_fitted_formula(df: pd.DataFrame, rr_shrink: dict, resource_v2: dict) -> np.ndarray:
    """Evaluate the exact formula serialized for the dashboard."""
    oc = df["overs_completed"].to_numpy(float)
    orr = df["overs_remaining"].to_numpy(float)
    wr = df["wickets_remaining"].to_numpy(float)
    rr = df["run_rate"].to_numpy(float)
    ph = _phase_index(oc)
    alpha = np.array(rr_shrink["alpha_by_phase"], dtype=float)
    mu = np.array(rr_shrink["mu_by_phase"], dtype=float)
    params = resource_v2["phase_params"]
    c = np.array([p["C"] for p in params], dtype=float)
    b = np.array([p["b"] for p in params], dtype=float)
    a = np.array([p["a_w"] for p in params], dtype=float)
    rr_eff = alpha[ph] * rr + (1.0 - alpha[ph]) * mu[ph]
    resource = _blended_resource(oc, orr, wr, c, b, a, resource_v2["wicket_gamma"])
    return df["current_score"].to_numpy(float) + rr_eff * resource


def evaluate_holdout_year(df: pd.DataFrame, holdout_year: int) -> dict:
    dates = pd.to_datetime(df["match_date"], errors="coerce")
    train = df[dates.dt.year < holdout_year].copy()
    test = df[dates.dt.year == holdout_year].copy()
    if train.empty or test.empty:
        return {"holdout_year": holdout_year, "available": False}

    rr = fit_rr_shrinkage(train)
    resource = fit_resource_v2(train, rr)
    rr["alpha_by_phase"] = resource["alpha_by_phase"]
    errors = np.abs(predict_fitted_formula(test, rr, resource) - test["final_total"].to_numpy(float))
    return {
        "holdout_year": holdout_year,
        "available": True,
        "train_matches": int(train["match_file"].nunique()),
        "test_matches": int(test["match_file"].nunique()),
        "test_rows": int(len(test)),
        "mae": float(np.mean(errors)),
        "rmse": float(np.sqrt(np.mean(errors ** 2))),
    }


def fit_legacy_phase_z0_a(df: pd.DataFrame):
    labels = [
        ("pp1_10", "Overs 1–10"),
        ("mid11_40", "Overs 11–40"),
        ("death41_50", "Overs 41–50"),
    ]
    oc = df["overs_completed"].values
    ph = _phase_index(oc)
    out = []
    for k, (pid, label) in enumerate(labels):
        d = df[ph == k]
        if len(d) < 20:
            out.append({"id": pid, "label": label, "Z0": 1.4, "a": 0.05})
            continue
        z0 = float(np.clip(
            np.mean((d["final_total"] - d["current_score"]) / np.maximum(1e-6, d["run_rate"] * d["overs_remaining"])),
            1.0,
            2.5,
        ))
        a = float(np.clip(np.std(d["wickets_remaining"]) / 100.0, 0.0001, 0.25))
        out.append({"id": pid, "label": label, "Z0": z0, "a": a})
    return out


def write_model_params(path: str, rr_shrink: dict, resource_v2: dict, legacy_phases: list, stats: dict, holdout_metrics: dict):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = {
        "version": 1,
        "format": "ODI",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "min_match_date": f"{MIN_YEAR}-01-01",
        "max_overs": MAX_OVERS,
        "max_wickets": MAX_WICKETS,
        "rr_shrinkage": {
            "alpha_by_phase": rr_shrink["alpha_by_phase"],
            "mu_by_phase": rr_shrink["mu_by_phase"],
            "phase_labels": ["Overs 1–10", "Overs 11–40", "Overs 41–50"],
            "formula": "RR_eff = α_k×RR + (1−α_k)×μ_k; k = ODI phase (1–10, 11–40, 41–50)",
        },
        "resource_model": {
            "phase_labels": ["Overs 1–10", "Overs 11–40", "Overs 41–50"],
            "phases": resource_v2["phase_params"],
            "wicket_gamma": resource_v2["wicket_gamma"],
            "phase_blend_overs": resource_v2["phase_blend_overs"],
            "formula": "R = C_k*(1-exp(-b_k*overs_remaining))*exp(-a_k*wickets_lost^gamma), blended near 10 and 40 overs",
        },
        "phases": legacy_phases,
        "fit_metrics": {
            "rr_shrink_initial_mae_objective": rr_shrink["mae_objective"],
            "resource_v2_mae_objective": resource_v2["mae_objective"],
            "resource_v2_optimizer_success": resource_v2["optimizer_success"],
        },
        "holdout_metrics": holdout_metrics,
        "update_stats": stats,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-download", action="store_true", help="Fit from existing odis_json/ only")
    parser.add_argument("--holdout-year", type=int, default=None, help="Calendar year reserved for formula-only evaluation")
    args = parser.parse_args()

    merge_stats = {"added": 0, "updated": 0, "unchanged": 0, "skipped_download": args.skip_download}
    if not args.skip_download:
        print("[1/5] Downloading latest ODI zip...")
        zip_bytes = _download_zip_bytes(CRICSHEET_ODI_ZIP)
        print("[2/5] Merging JSON files...")
        merge_stats = _merge_match_jsons(zip_bytes, JSON_DIR)
        print("  merge:", merge_stats)
    else:
        print("[1/5] Skipping download")
        print("[2/5] Using existing odis_json/")

    print("[3/5] Rebuilding snapshots CSV...")
    extract_innings_snapshots_from_odis()
    if not os.path.isfile(CSV_PATH):
        raise RuntimeError("ODI CSV generation failed")

    print("[4/5] Fitting parameters...")
    df_train = _load_training_df(CSV_PATH)
    if len(df_train) < 500:
        raise RuntimeError(f"Too few ODI training rows: {len(df_train)}")
    available_years = pd.to_datetime(df_train["match_date"], errors="coerce").dt.year.dropna()
    holdout_year = args.holdout_year or (int(available_years.max()) - 1)
    holdout_metrics = evaluate_holdout_year(df_train, holdout_year)
    rr = fit_rr_shrinkage(df_train)
    rv2 = fit_resource_v2(df_train, rr)
    rr["alpha_by_phase"] = rv2["alpha_by_phase"]
    legacy = fit_legacy_phase_z0_a(df_train)

    print("[5/5] Writing odi_model_params.json...")
    stats = {
        "matches_in_training": int(df_train["match_file"].nunique()),
        "rows_in_training": int(len(df_train)),
        **merge_stats,
    }
    write_model_params(MODEL_PARAMS_PATH, rr, rv2, legacy, stats, holdout_metrics)
    print("Done.", MODEL_PARAMS_PATH, "updated. MAE", rv2["mae_objective"])


if __name__ == "__main__":
    main()
