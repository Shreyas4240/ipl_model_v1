"""
Sanity check: MAE for global Z0/a (pre-powerplay) vs piecewise PHASE_Z0_A (after).
Same data: complete innings, snapshots at 10 and 15 overs, all-time window.
"""
import numpy as np

from ipl_service import (
    get_match_metadata,
    get_recent_and_upcoming,
    load_snapshots_csv,
    filter_complete_innings_only,
    sample_snapshots_at_overs,
    predict_score,
    PHASE_Z0_A,
)

# Pre-powerplay single model (historical IPL global fit for comparison)
GLOBAL_Z0 = 1.5098
GLOBAL_A = 0.0511


def main():
    meta = get_match_metadata("ipl_male_json")
    recent, _ = get_recent_and_upcoming(meta, past_days=9999)
    df = load_snapshots_csv("ipl_innings_snapshots.csv")
    if df is None:
        print("No CSV")
        return
    df = filter_complete_innings_only(df)

    errs_global = []
    errs_piece = []

    for match_file, m, _ in recent:
        df_m = df[df["match_file"] == match_file]
        if df_m.empty:
            continue
        for row in sample_snapshots_at_overs(df_m):
            oc = float(row["overs_completed"])
            wr = float(row["wickets_remaining"])
            pred_g = predict_score(
                row["current_score"],
                row["run_rate"],
                row["overs_remaining"],
                wr,
                oc,
                Z0=GLOBAL_Z0,
                a=GLOBAL_A,
            )
            pred_p = predict_score(
                row["current_score"],
                row["run_rate"],
                row["overs_remaining"],
                wr,
                oc,
            )
            actual = row["final_total"]
            errs_global.append(abs(pred_g - actual))
            errs_piece.append(abs(pred_p - actual))

    n = len(errs_global)
    mae_g = float(np.mean(errs_global))
    mae_p = float(np.mean(errs_piece))
    rmse_g = float(np.sqrt(np.mean(np.square(errs_global))))
    rmse_p = float(np.sqrt(np.mean(np.square(errs_piece))))

    print("Sanity test — same predictions (10 & 15 over marks, complete innings only)")
    print(f"  N predictions:     {n}")
    print()
    print("  BEFORE (single global Z0, a):")
    print(f"    Z0 = {GLOBAL_Z0}, a = {GLOBAL_A}")
    print(f"    MAE:  {mae_g:.2f} runs")
    print(f"    RMSE: {rmse_g:.2f} runs")
    print()
    print("  AFTER (piecewise powerplay PHASE_Z0_A):")
    for i, label in enumerate(["1–6", "7–16", "17–20"]):
        z0, a = PHASE_Z0_A[i]
        print(f"    overs {label}: Z0={z0:.6f}, a={a:.6f}")
    print(f"    MAE:  {mae_p:.2f} runs")
    print(f"    RMSE: {rmse_p:.2f} runs")
    print()
    print(f"  Δ MAE (before − after): {mae_g - mae_p:+.2f} runs  (positive means piecewise is better)")


if __name__ == "__main__":
    main()
