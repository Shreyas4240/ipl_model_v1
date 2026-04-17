import numpy as np
from ipl_service import get_match_metadata, get_recent_and_upcoming, load_snapshots_csv, filter_complete_innings_only, sample_snapshots_at_overs

meta = get_match_metadata("ipl_male_json")
recent, _ = get_recent_and_upcoming(meta, past_days=9999)
df = load_snapshots_csv("ipl_innings_snapshots.csv")
df = filter_complete_innings_only(df)

params_3 = [(1.54, 0), (1.15, 0), (1.83, 0.03)] # approximate

def pred_raw(curr, rr, overs_rem, w_rem, Z0, a):
    return curr + rr * Z0 * overs_rem * np.exp(-a * (10 - w_rem))

errs = []
for match_file, m, _ in recent:
    df_m = df[df["match_file"] == match_file]
    if df_m.empty: continue
    for row in sample_snapshots_at_overs(df_m):
        oc = float(row["overs_completed"])
        wr = float(row["wickets_remaining"])
        Z0, a = 1.5, 0.05
        pred = pred_raw(row["current_score"], row["run_rate"], row["overs_remaining"], wr, Z0, a)
        errs.append(abs(pred - row["final_total"]))

print(f"RAW Z0/a MAE: {np.mean(errs)}")
