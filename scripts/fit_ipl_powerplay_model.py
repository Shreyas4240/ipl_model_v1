"""
Fit separate Z0 and a for each powerplay segment (overs_completed in 1-6, 7-16, 17-20).
Uses ipl_innings_snapshots.csv with the same cleaning as ipl_service.
By default excludes all innings from calendar year 2022 (match date from ipl_male_json).
"""
import json
import os

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

JSON_DIR = "ipl_male_json"
EXCLUDE_YEARS = {2022}

MAX_OVERS = 20
MAX_WICKETS = 10

# Phase by overs_completed in the innings (after 6th over = middle, after 16th = death)
def powerplay_phase(overs_completed: float) -> int:
    oc = float(overs_completed)
    if oc <= 6:
        return 0  # 1-6
    if oc <= 9:
        return 1  # 7-9
    if oc <= 13:
        return 2  # 10-13
    if oc <= 16:
        return 3  # 14-16
    return 4  # 17-20


def resource_function(X, Z0, a):
    w_r, o_r = X
    return Z0 * o_r * np.exp(-a * (MAX_WICKETS - w_r))


def filter_complete_innings(df):
    g = df.groupby(["match_file", "team"])
    last_overs = g["overs_completed"].transform("max")
    last_wickets = g["wickets"].transform("max")
    complete = (last_overs >= MAX_OVERS) | (last_wickets >= MAX_WICKETS)
    return df[complete].copy()


def match_file_year(match_file: str):
    """Return calendar year from info.dates[0], or None if missing."""
    path = os.path.join(JSON_DIR, match_file if match_file.endswith(".json") else match_file + ".json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
        dates = (data.get("info") or {}).get("dates") or []
        if not dates:
            return None
        s = str(dates[0])[:10]
        return int(s[:4])
    except (json.JSONDecodeError, ValueError, TypeError):
        return None


def exclude_years_from_df(df, years):
    """Drop rows whose match_file maps to a date in `years`."""
    if not years:
        return df
    unique_files = df["match_file"].unique()
    keep_files = set()
    dropped = 0
    for mf in unique_files:
        y = match_file_year(mf)
        if y is None or y not in years:
            keep_files.add(mf)
        else:
            dropped += 1
    print(f"Excluded {dropped} match files with date in {sorted(years)} (by ipl_male_json).")
    return df[df["match_file"].isin(keep_files)].copy()


def main():
    df = pd.read_csv("ipl_innings_snapshots.csv")
    df = exclude_years_from_df(df, EXCLUDE_YEARS)
    df["wickets_remaining"] = MAX_WICKETS - df["wickets"]
    df = filter_complete_innings(df)
    df = df[(df["final_total"] > 0) & (df["run_rate"] > 0)]
    df = df[(df["wickets_remaining"] > 0) & (df["overs_remaining"] > 0)]
    df["resource_units"] = (df["final_total"] - df["current_score"]) / df["run_rate"]
    df = df[np.isfinite(df["resource_units"]) & (df["resource_units"] > 0)]

    df["phase"] = df["overs_completed"].apply(powerplay_phase)

    print("Rows per phase:", df["phase"].value_counts().sort_index())

    params_out = []
    labels = ["1-6", "7-9", "10-13", "14-16", "17-20"]
    for phase in range(5):
        dfp = df[df["phase"] == phase]
        if len(dfp) < 50:
            print(f"Phase {phase}: insufficient data ({len(dfp)} rows), using global fallback")
            params_out.append((1.51, 0.051))
            continue
        X_data = (dfp["wickets_remaining"], dfp["overs_remaining"])
        y_data = dfp["resource_units"].values
        try:
            p0 = [1.2, 0.05]
            params, _ = curve_fit(
                resource_function,
                X_data,
                y_data,
                p0=p0,
                bounds=([1.0, 0.0], [2.5, 0.25]),
                maxfev=20000,
            )
            Z0, a = float(params[0]), float(params[1])
            print(f"Phase {phase} (overs {labels[phase]}): Z0={Z0:.4f}, a={a:.4f}, n={len(dfp)}")
            params_out.append((Z0, a))
        except Exception as e:
            print(f"Phase {phase} fit failed: {e}, using defaults")
            params_out.append((1.51, 0.051))

    # Calculate MAE
    def predict_total(row):
        Z0_phase, a_phase = params_out[row["phase"]]
        pred_ru = resource_function((row["wickets_remaining"], row["overs_remaining"]), Z0_phase, a_phase)
        return row["current_score"] + row["run_rate"] * pred_ru

    predicted_totals = df.apply(predict_total, axis=1)
    mae = (df["final_total"] - predicted_totals).abs().mean()
    print(f"\nOverall MAE on Final Total: {mae:.4f}")

    print("\n# Copy into ipl_service.py and api/recent.js:")
    out_labels = ["pp1_6", "pp7_9", "pp10_13", "pp14_16", "pp17_20"]
    for i, (Z0, a) in enumerate(params_out):
        print(f"  {out_labels[i]}: Z0={Z0:.6f}, a={a:.6f}")


if __name__ == "__main__":
    main()
