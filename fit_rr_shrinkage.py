"""
Fit RR shrinkage by powerplay segment (same k as Z₀, a): overs 1–6, 7–16, 17–20.

RR_eff = α_k × RR + (1 − α_k) × μ_k
  μ_k = mean run_rate in segment k (2023+ IPL, complete innings)
  α_k ∈ [0,1] chosen to minimize MAE(predicted final, actual final) on all ball rows.

Print constants for ipl_service.py, api/recent.js, index.html.
"""
from __future__ import annotations

import json
import os

import numpy as np
from scipy.optimize import minimize

from ipl_service import (
    MAX_WICKETS,
    MIN_MATCH_DATE,
    PHASE_Z0_A,
    filter_complete_innings_only,
    load_snapshots_csv,
)

JSON_DIR = "ipl_male_json"


def match_file_date(match_file: str) -> str | None:
    path = os.path.join(
        JSON_DIR, match_file if match_file.endswith(".json") else match_file + ".json"
    )
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
        dates = (data.get("info") or {}).get("dates") or []
        return str(dates[0])[:10] if dates else None
    except (json.JSONDecodeError, TypeError):
        return None


def main():
    df = load_snapshots_csv("ipl_innings_snapshots.csv")
    if df is None or df.empty:
        print("No CSV")
        return

    df = filter_complete_innings_only(df)
    df = df[(df["final_total"] > 0) & (df["run_rate"] > 0)].copy()
    df["wickets_remaining"] = MAX_WICKETS - df["wickets"]
    df = df[(df["wickets_remaining"] > 0) & (df["overs_remaining"] > 0)]

    dates = {}
    for mf in df["match_file"].unique():
        dates[mf] = match_file_date(str(mf))
    df["_d"] = df["match_file"].map(dates)
    df = df[df["_d"].notna() & (df["_d"] >= MIN_MATCH_DATE.isoformat())]
    df = df.drop(columns=["_d"])
    if len(df) < 500:
        print(f"Too few rows after date filter: {len(df)}")
        return

    oc = df["overs_completed"].values
    rr = df["run_rate"].values.astype(float)
    ph = np.where(oc <= 6, 0, np.where(oc <= 9, 1, np.where(oc <= 13, 2, np.where(oc <= 16, 3, 4)))).astype(int)

    gmu = float(np.mean(rr))
    mu_phase = np.array(
        [
            float(np.mean(rr[ph == k])) if np.any(ph == k) else gmu
            for k in range(5)
        ]
    )
    print("Rows per phase:", [int(np.sum(ph == k)) for k in range(5)])
    print("μ_k (mean RR):", mu_phase)

    curr = df["current_score"].values.astype(float)
    final = df["final_total"].values.astype(float)
    or_rem = df["overs_remaining"].values.astype(float)
    wr = df["wickets_remaining"].values.astype(float)

    z0 = np.array([PHASE_Z0_A[p][0] for p in ph])
    aa = np.array([PHASE_Z0_A[p][1] for p in ph])
    mu_row = mu_phase[ph]
    resource = z0 * or_rem * np.exp(-aa * (MAX_WICKETS - wr))

    def mae_vec(x: np.ndarray) -> float:
        a0, a1, a2, a3, a4 = x
        alpha_row = np.choose(ph, [a0, a1, a2, a3, a4])
        rr_eff = alpha_row * rr + (1.0 - alpha_row) * mu_row
        pred = curr + rr_eff * resource
        return float(np.mean(np.abs(pred - final)))

    res = minimize(
        mae_vec,
        x0=[0.15, 0.35, 0.35, 0.35, 0.5],
        bounds=[(0.0, 1.0)] * 5,
        method="L-BFGS-B",
    )
    alphas = res.x
    print(f"Optimal α_k: {alphas}, MAE {res.fun:.4f}")
    print(f"MAE α=(1,1,1,1,1): {mae_vec(np.ones(5)):.4f}")
    print(f"MAE α=(0,0,0,0,0): {mae_vec(np.zeros(5)):.4f}")

    def fmt_tuple(vals):
        return "(" + ", ".join(f"{v:.6f}" for v in vals) + ")"

    print("\n--- Paste into ipl_service.py ---")
    print(f"RR_SHRINK_ALPHA_PHASE = {fmt_tuple(alphas)}")
    print(f"RR_PHASE_MU = {fmt_tuple(mu_phase)}")

    print("\n--- Paste into api/recent.js ---")
    print(f"const RR_SHRINK_ALPHA_PHASE = [{', '.join(f'{a:.6f}' for a in alphas)}];")
    print(f"const RR_PHASE_MU = [{', '.join(f'{m:.6f}' for m in mu_phase)}];")


if __name__ == "__main__":
    main()
