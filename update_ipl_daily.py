"""
Daily IPL data/model updater.

What it does:
1) Downloads latest IPL JSON zip from Cricsheet.
2) Merges new/updated match JSON files into ipl_male_json/.
3) Rebuilds ipl_innings_snapshots.csv.
4) Refits RR shrinkage and resource-v2 params.
5) Writes model_params.json used by app/api at runtime.
"""
from __future__ import annotations

import io
import json
import os
import zipfile
from datetime import datetime, timezone
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from process_ipl_data import extract_innings_snapshots_from_ipl

CRICSHEET_IPL_ZIP = "https://cricsheet.org/downloads/ipl_json.zip"
JSON_DIR = "ipl_male_json"
MODEL_PARAMS_PATH = "model_params.json"
CSV_PATH = "ipl_innings_snapshots.csv"
MIN_YEAR = 2023
MAX_OVERS = 20
MAX_WICKETS = 10


def _download_zip_bytes(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": "ipl-model-updater/1.0"})
    with urlopen(req, timeout=120) as resp:
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


def _match_file_year(json_dir: str, match_file: str):
    path = os.path.join(json_dir, match_file if match_file.endswith(".json") else match_file + ".json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
        dates = (data.get("info") or {}).get("dates") or []
        if not dates:
            return None
        return int(str(dates[0])[:4])
    except Exception:
        return None


def _load_training_df(csv_path: str, json_dir: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)
    df = _filter_complete_innings(df)
    df = df[(df["final_total"] > 0) & (df["run_rate"] > 0)].copy()
    df["wickets_remaining"] = MAX_WICKETS - df["wickets"]
    df = df[(df["wickets_remaining"] > 0) & (df["overs_remaining"] > 0)]
    keep = []
    for mf in df["match_file"].astype(str).unique():
        y = _match_file_year(json_dir, mf)
        if y is None or y >= MIN_YEAR:
            keep.append(mf)
    df = df[df["match_file"].astype(str).isin(set(keep))].copy()
    return df


def fit_rr_shrinkage(df: pd.DataFrame):
    oc = df["overs_completed"].values.astype(float)
    rr = df["run_rate"].values.astype(float)
    ph = np.where(oc <= 6, 0, np.where(oc <= 16, 1, 2)).astype(int)
    gmu = float(np.mean(rr))
    mu_phase = np.array([float(np.mean(rr[ph == k])) if np.any(ph == k) else gmu for k in range(3)])

    # Temporary baseline Z0/a from previous fit used only for rr shrink fitting objective.
    phase_z0_a = np.array([[1.571700, 0.019395], [1.190465, 0.000344], [1.853324, 0.031399]], dtype=float)
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

    res = minimize(mae_vec, x0=[0.15, 0.35, 0.5], bounds=[(0.0, 1.0)] * 3, method="L-BFGS-B")
    alphas = [float(v) for v in res.x]
    mus = [float(v) for v in mu_phase]
    return {"alpha_by_phase": alphas, "mu_by_phase": mus, "mae_objective": float(res.fun)}


def fit_resource_v2(df: pd.DataFrame, rr_shrink: dict):
    oc = df["overs_completed"].to_numpy(float)
    orr = df["overs_remaining"].to_numpy(float)
    wr = df["wickets_remaining"].to_numpy(float)
    rr = df["run_rate"].to_numpy(float)
    cur = df["current_score"].to_numpy(float)
    act = df["final_total"].to_numpy(float)
    ph = np.where(oc <= 6, 0, np.where(oc <= 16, 1, 2)).astype(int)

    alpha = np.array(rr_shrink["alpha_by_phase"], dtype=float)
    mu = np.array(rr_shrink["mu_by_phase"], dtype=float)
    rr_eff = alpha[ph] * rr + (1.0 - alpha[ph]) * mu[ph]

    def unpack(x):
        c = np.array(x[0:3], dtype=float)
        b = np.array(x[3:6], dtype=float)
        a = np.array(x[6:9], dtype=float)
        g = float(x[9])
        return c, b, a, g

    def predict_vec(x):
        c, b, a, g = unpack(x)
        wl = MAX_WICKETS - wr
        resource = c[ph] * (1.0 - np.exp(-b[ph] * orr)) * np.exp(-a[ph] * np.power(wl, g))
        return cur + rr_eff * resource

    def mae_all(x):
        p = predict_vec(x)
        if not np.all(np.isfinite(p)):
            return 1e9
        return float(np.mean(np.abs(p - act)))

    x0 = np.array([35.0, 30.0, 45.0, 0.05, 0.05, 0.04, 0.01, 0.003, 0.002, 2.2], dtype=float)
    bounds = [
        (8.0, 80.0), (8.0, 80.0), (8.0, 80.0),
        (0.01, 0.35), (0.01, 0.35), (0.01, 0.35),
        (0.001, 0.25), (0.001, 0.25), (0.001, 0.25),
        (1.0, 2.5),
    ]
    res = minimize(mae_all, x0=x0, method="L-BFGS-B", bounds=bounds, options={"maxiter": 400})
    c, b, a, g = unpack(res.x)
    return {
        "phase_params": [
            {"id": "pp1_6", "label": "Overs 1–6", "C": float(c[0]), "b": float(b[0]), "a_w": float(a[0])},
            {"id": "pp7_16", "label": "Overs 7–16", "C": float(c[1]), "b": float(b[1]), "a_w": float(a[1])},
            {"id": "pp17_20", "label": "Overs 17–20", "C": float(c[2]), "b": float(b[2]), "a_w": float(a[2])},
        ],
        "wicket_gamma": float(g),
        "phase_blend_overs": 0.5,
        "mae_objective": float(res.fun),
        "optimizer_success": bool(res.success),
    }


def fit_legacy_phase_z0_a(df: pd.DataFrame):
    # Keep legacy Z0/a in payload for UI compatibility, but computed from new resource fit inputs.
    out = []
    for k in range(3):
        d = df[np.where(df["overs_completed"].values <= 6, 0, np.where(df["overs_completed"].values <= 16, 1, 2)) == k]
        if len(d) < 20:
            out.append({"id": ["pp1_6", "pp7_16", "pp17_20"][k], "label": ["Overs 1–6", "Overs 7–16", "Overs 17–20"][k], "Z0": 1.5, "a": 0.05})
            continue
        # quick proxy estimate for legacy display only
        z0 = float(np.clip(np.mean((d["final_total"] - d["current_score"]) / np.maximum(1e-6, d["run_rate"] * d["overs_remaining"])), 1.0, 2.5))
        a = float(np.clip(np.std(d["wickets_remaining"]) / 100.0, 0.0001, 0.25))
        out.append({"id": ["pp1_6", "pp7_16", "pp17_20"][k], "label": ["Overs 1–6", "Overs 7–16", "Overs 17–20"][k], "Z0": z0, "a": a})
    return out


def write_model_params(path: str, rr_shrink: dict, resource_v2: dict, legacy_phases: list, stats: dict):
    payload = {
        "version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "min_match_date": f"{MIN_YEAR}-01-01",
        "max_overs": MAX_OVERS,
        "max_wickets": MAX_WICKETS,
        "rr_shrinkage": {
            "alpha_by_phase": rr_shrink["alpha_by_phase"],
            "mu_by_phase": rr_shrink["mu_by_phase"],
            "phase_labels": ["Overs 1–6", "Overs 7–16", "Overs 17–20"],
            "formula": "RR_eff = α_k×RR + (1−α_k)×μ_k; k = same segment as resource phase",
        },
        "resource_model": {
            "phase_labels": ["Overs 1–6", "Overs 7–16", "Overs 17–20"],
            "phases": resource_v2["phase_params"],
            "wicket_gamma": resource_v2["wicket_gamma"],
            "phase_blend_overs": resource_v2["phase_blend_overs"],
            "formula": "R = C_k*(1-exp(-b_k*overs_remaining))*exp(-a_k*wickets_lost^gamma), blended near 6 and 16 overs",
        },
        "phases": legacy_phases,
        "fit_metrics": {
            "rr_shrink_mae_objective": rr_shrink["mae_objective"],
            "resource_v2_mae_objective": resource_v2["mae_objective"],
            "resource_v2_optimizer_success": resource_v2["optimizer_success"],
        },
        "update_stats": stats,
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def main():
    print("[1/5] Downloading latest IPL zip...")
    zip_bytes = _download_zip_bytes(CRICSHEET_IPL_ZIP)
    print("[2/5] Merging JSON files...")
    merge_stats = _merge_match_jsons(zip_bytes, JSON_DIR)
    print("  merge:", merge_stats)

    print("[3/5] Rebuilding snapshots CSV...")
    extract_innings_snapshots_from_ipl()
    if not os.path.isfile(CSV_PATH):
        raise RuntimeError("CSV generation failed")

    print("[4/5] Fitting parameters...")
    df_train = _load_training_df(CSV_PATH, JSON_DIR)
    rr = fit_rr_shrinkage(df_train)
    rv2 = fit_resource_v2(df_train, rr)
    legacy = fit_legacy_phase_z0_a(df_train)

    print("[5/5] Writing model_params.json...")
    stats = {
        "matches_in_training": int(df_train["match_file"].nunique()),
        "rows_in_training": int(len(df_train)),
        **merge_stats,
    }
    write_model_params(MODEL_PARAMS_PATH, rr, rv2, legacy, stats)
    print("Done. model_params.json updated.")


if __name__ == "__main__":
    main()

