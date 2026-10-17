"""
Service layer for the ODI resource model.

Independent of ipl_service.py. Loads odi_innings_snapshots.csv and odis_json/,
and uses data/odi_model_params.json when present.

Phases by overs_completed: five equal 10-over segments from 1–10 through 41–50.
"""
from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

PHASE_Z0_A = (
    (1.40, 0.010),  # overs 1–10
    (1.30, 0.009),  # overs 11–20
    (1.20, 0.008),  # overs 21–30
    (1.40, 0.014),  # overs 31–40
    (1.70, 0.020),  # overs 41–50
)
RESOURCE_PHASE_PARAMS = (
    (55.0, 0.074, 0.034),
    (50.0, 0.055, 0.021),
    (40.0, 0.068, 0.013),
)
RESOURCE_WICKET_GAMMA = 2.08
PHASE_BLEND_OVERS = 1.0
RR_SHRINK_ALPHA_PHASE = (0.052, 0.166, 0.304)
RR_PHASE_MU = (4.90, 5.15, 5.67)
MAX_OVERS = 50
MAX_WICKETS = 10
MIN_MATCH_DATE = date(2023, 1, 1)
PHASE_BOUNDARIES = (10.0, 40.0)
PHASE_COUNT = 3
SAMPLE_OVER_POINTS = (30, 35, 40, 45)
MODEL_PARAMS_FILE = os.path.join("data", "odi_model_params.json")


def _load_runtime_model_params(path: str = MODEL_PARAMS_FILE):
    if not os.path.isfile(path):
        return
    try:
        with open(path, "r") as f:
            p = json.load(f)

        rr = p.get("rr_shrinkage") or {}
        rm = p.get("resource_model") or {}
        phases = rm.get("phases") or []
        legacy = p.get("phases") or []
        min_date = p.get("min_match_date")

        global RR_SHRINK_ALPHA_PHASE, RR_PHASE_MU
        global RESOURCE_PHASE_PARAMS, RESOURCE_WICKET_GAMMA, PHASE_BLEND_OVERS
        global PHASE_Z0_A, MIN_MATCH_DATE

        if isinstance(rr.get("alpha_by_phase"), list) and len(rr["alpha_by_phase"]) == PHASE_COUNT:
            RR_SHRINK_ALPHA_PHASE = tuple(float(x) for x in rr["alpha_by_phase"])
        if isinstance(rr.get("mu_by_phase"), list) and len(rr["mu_by_phase"]) == PHASE_COUNT:
            RR_PHASE_MU = tuple(float(x) for x in rr["mu_by_phase"])

        if isinstance(phases, list) and len(phases) == PHASE_COUNT:
            RESOURCE_PHASE_PARAMS = tuple(
                (float(ph["C"]), float(ph["b"]), float(ph["a_w"])) for ph in phases
            )
        if rm.get("wicket_gamma") is not None:
            RESOURCE_WICKET_GAMMA = float(rm["wicket_gamma"])
        if rm.get("phase_blend_overs") is not None:
            PHASE_BLEND_OVERS = float(rm["phase_blend_overs"])

        if isinstance(legacy, list) and len(legacy) == PHASE_COUNT:
            PHASE_Z0_A = tuple((float(ph["Z0"]), float(ph["a"])) for ph in legacy)

        if isinstance(min_date, str) and len(min_date) >= 10:
            MIN_MATCH_DATE = datetime.strptime(min_date[:10], "%Y-%m-%d").date()
    except Exception:
        pass


_load_runtime_model_params()


def odi_phase(overs_completed: float) -> int:
    oc = float(overs_completed)
    for phase_idx, boundary in enumerate(PHASE_BOUNDARIES):
        if oc <= boundary:
            return phase_idx
    return PHASE_COUNT - 1


def effective_run_rate(run_rate: float, overs_completed: float) -> float:
    k = odi_phase(overs_completed)
    alpha = RR_SHRINK_ALPHA_PHASE[k]
    mu = RR_PHASE_MU[k]
    return alpha * float(run_rate) + (1.0 - alpha) * mu


def _resource_for_phase(
    phase_idx: int,
    overs_remaining: float,
    wickets_remaining: float,
    max_wickets: int = MAX_WICKETS,
    gamma: float = RESOURCE_WICKET_GAMMA,
) -> float:
    c_k, b_k, a_k = RESOURCE_PHASE_PARAMS[phase_idx]
    overs_r = max(0.0, float(overs_remaining))
    wickets_lost = max(0.0, float(max_wickets - wickets_remaining))
    return c_k * (1.0 - np.exp(-b_k * overs_r)) * np.exp(-a_k * (wickets_lost ** gamma))


def _raw_resource_factor(
    overs_remaining: float,
    wickets_remaining: float,
    overs_completed: float,
    max_wickets: int = MAX_WICKETS,
) -> float:
    oc = float(overs_completed)
    d = PHASE_BLEND_OVERS
    for phase_idx, boundary in enumerate(PHASE_BOUNDARIES):
        if boundary - d < oc < boundary + d:
            t = (oc - (boundary - d)) / (2.0 * d)
            left = _resource_for_phase(phase_idx, overs_remaining, wickets_remaining, max_wickets)
            right = _resource_for_phase(phase_idx + 1, overs_remaining, wickets_remaining, max_wickets)
            return (1.0 - t) * left + t * right
    return _resource_for_phase(odi_phase(oc), overs_remaining, wickets_remaining, max_wickets)


def resource_factor(
    overs_remaining: float,
    wickets_remaining: float,
    overs_completed: float,
    max_wickets: int = MAX_WICKETS,
) -> float:
    """Return remaining resource without allowing a phase boundary to add it back."""
    completed_balls = min(MAX_OVERS * 6, max(0, int(np.ceil(float(overs_completed) * 6 - 1e-9))))
    resource = float("inf")
    for ball in range(completed_balls + 1):
        completed = ball / 6.0
        raw = _raw_resource_factor(
            MAX_OVERS - completed,
            wickets_remaining,
            completed,
            max_wickets,
        )
        resource = min(resource, raw)
    return resource


def predict_score(
    current_score,
    run_rate,
    overs_remaining,
    wickets_remaining,
    overs_completed,
    Z0=None,
    a=None,
    max_overs=MAX_OVERS,
    max_wickets=MAX_WICKETS,
):
    rr_eff = effective_run_rate(run_rate, overs_completed)
    rf = resource_factor(overs_remaining, wickets_remaining, overs_completed, max_wickets)
    return current_score + rr_eff * rf


def get_match_metadata(json_dir="odis_json"):
    meta = {}
    if not os.path.isdir(json_dir):
        return meta
    for name in os.listdir(json_dir):
        if not name.endswith(".json"):
            continue
        path = os.path.join(json_dir, name)
        try:
            with open(path, "r") as f:
                data = json.load(f)
            info = data.get("info", {})
            if info.get("match_type") != "ODI":
                continue
            if str(info.get("gender") or "").lower() != "male":
                continue
            dates = info.get("dates", [])
            date_str = dates[0] if dates else None
            teams = info.get("teams", [])
            event = info.get("event", {})
            event_name = event.get("name", "") if isinstance(event, dict) else ""
            venue = info.get("venue", "") or info.get("city", "")
            meta[name] = {
                "date": date_str,
                "teams": teams,
                "event": event_name,
                "venue": venue,
            }
        except (json.JSONDecodeError, KeyError):
            continue
    return meta


def get_recent_and_upcoming(meta, past_days=30):
    today = datetime.now().date()
    cutoff = today - timedelta(days=min(past_days, 365 * 50))
    recent, upcoming = [], []
    for match_file, m in meta.items():
        if not m["date"]:
            continue
        try:
            d = datetime.strptime(str(m["date"])[:10], "%Y-%m-%d").date()
            if d >= today:
                upcoming.append((match_file, m, d))
            elif d >= cutoff and d >= MIN_MATCH_DATE:
                recent.append((match_file, m, d))
        except ValueError:
            continue
    recent.sort(key=lambda x: x[2], reverse=True)
    upcoming.sort(key=lambda x: x[2])
    return recent, upcoming


def load_snapshots_csv(csv_path="odi_innings_snapshots.csv"):
    if not os.path.isfile(csv_path):
        return None
    df = pd.read_csv(csv_path)
    df["wickets_remaining"] = MAX_WICKETS - df["wickets"]
    return df


def filter_complete_innings_only(df, max_overs=MAX_OVERS, max_wickets=MAX_WICKETS):
    if df is None or df.empty:
        return df
    g = df.groupby(["match_file", "team"])
    last_overs = g["overs_completed"].transform("max")
    last_wickets = g["wickets"].transform("max")
    complete = (last_overs >= max_overs) | (last_wickets >= max_wickets)
    return df[complete].copy()


def sample_snapshots_at_overs(df_match, overs_points=SAMPLE_OVER_POINTS):
    rows = []
    for target_over in overs_points:
        exact = df_match[np.isclose(df_match["overs_completed"], target_over)]
        if exact.empty:
            continue
        row = exact.iloc[-1]
        if row["overs_remaining"] > 0 and row["run_rate"] > 0 and row["wickets_remaining"] > 0:
            rows.append(row)
    return rows


def build_recent_test_results(recent_matches, df_snapshots):
    results = []
    for match_file, m, d in recent_matches:
        df_m = df_snapshots[df_snapshots["match_file"] == match_file]
        if df_m.empty:
            continue
        team_name = df_m["team"].iloc[0]
        snapshots = sample_snapshots_at_overs(df_m)
        for row in snapshots:
            oc = float(row["overs_completed"])
            ph = odi_phase(oc)
            pred = predict_score(
                row["current_score"],
                row["run_rate"],
                row["overs_remaining"],
                row["wickets_remaining"],
                oc,
            )
            actual = row["final_total"]
            results.append({
                "match_file": match_file,
                "date": m["date"],
                "teams": m["teams"],
                "event": m["event"],
                "venue": m["venue"],
                "innings_team": str(team_name),
                "at_over": round(oc, 1),
                "powerplay_phase": ph,
                "current_score": int(row["current_score"]),
                "run_rate": round(float(row["run_rate"]), 2),
                "wickets_lost": int(row["wickets"]),
                "overs_remaining": round(float(row["overs_remaining"]), 1),
                "predicted": round(float(pred), 1),
                "actual": int(actual),
                "error": round(float(abs(pred - actual)), 1),
            })
    return results


def _model_params_payload():
    return {
        "max_overs": MAX_OVERS,
        "max_wickets": MAX_WICKETS,
        "min_match_date": MIN_MATCH_DATE.isoformat(),
        "format": "ODI",
        "phases": [
            {"id": f"overs_{start}_{start + 9}", "label": f"Overs {start}\u2013{start + 9}", "Z0": PHASE_Z0_A[i][0], "a": PHASE_Z0_A[i][1]}
            for i, start in enumerate((1, 11, 41))
        ],
        "rr_shrinkage": {
            "alpha_by_phase": list(RR_SHRINK_ALPHA_PHASE),
            "mu_by_phase": list(RR_PHASE_MU),
            "phase_labels": ["Overs 1–10", "Overs 11–40", "Overs 41–50"],
            "formula": "RR_eff = α_k×RR + (1−α_k)×μ_k; k = ODI phase (2023+ men's ODIs)",
        },
        "resource_model": {
            "phase_labels": ["Overs 1–10", "Overs 11–40", "Overs 41–50"],
            "phases": [
                {"id": f"overs_{start}_{start + 9}", "label": f"Overs {start}\u2013{start + 9}", "C": RESOURCE_PHASE_PARAMS[i][0], "b": RESOURCE_PHASE_PARAMS[i][1], "a_w": RESOURCE_PHASE_PARAMS[i][2]}
                for i, start in enumerate((1, 11, 41))
            ],
            "wicket_gamma": RESOURCE_WICKET_GAMMA,
            "phase_blend_overs": PHASE_BLEND_OVERS,
            "formula": "R = C_k*(1-exp(-b_k*overs_remaining))*exp(-a_k*wickets_lost^gamma), blended near 10 and 40 overs",
        },
    }


def get_recent_results(past_days=30, csv_path="odi_innings_snapshots.csv", json_dir="odis_json"):
    meta = get_match_metadata(json_dir)
    recent, _ = get_recent_and_upcoming(meta, past_days)
    df = load_snapshots_csv(csv_path)
    if df is None:
        return {"results": [], "summary": {"count": 0, "mae": 0, "message": "ODI CSV not found"}, "model_params": _model_params_payload()}
    df = filter_complete_innings_only(df)
    test_results = build_recent_test_results(recent, df)
    if not test_results:
        return {
            "results": [],
            "summary": {"count": 0, "mae": 0, "message": f"No ODI matches in the last {past_days} days in dataset.", "days_requested": past_days},
            "model_params": _model_params_payload(),
        }
    errors = [r["error"] for r in test_results]
    return {
        "results": test_results,
        "summary": {
            "count": len(test_results),
            "matches_count": len({r["match_file"] for r in test_results}),
            "mae": round(float(np.mean(errors)), 2),
            "rmse": round(float(np.sqrt(np.mean([e ** 2 for e in errors]))), 2),
            "days_requested": past_days,
        },
        "model_params": _model_params_payload(),
    }


def get_upcoming_fixtures(past_days=30, json_dir="odis_json"):
    meta = get_match_metadata(json_dir)
    _, upcoming = get_recent_and_upcoming(meta, past_days)
    return [
        {
            "match_file": match_file,
            "date": m["date"],
            "teams": m["teams"],
            "event": m["event"],
            "venue": m["venue"],
            "source": "local",
        }
        for match_file, m, _ in upcoming
    ]
