"""
Extract innings snapshots from men's ODI JSON files into odi_innings_snapshots.csv.

Completely separate from the IPL pipeline. Uses odis_json/, 50-over innings,
male ODIs from MIN_YEAR onward.
"""
from __future__ import annotations

import json
import os
from datetime import datetime

import pandas as pd

JSON_DIR = "odis_json"
CSV_PATH = "odi_innings_snapshots.csv"
MIN_YEAR = 2023
MAX_OVERS = 50
GENDER = "male"
MATCH_TYPE = "ODI"
ILLEGAL_EXTRAS = {"wides", "noballs"}
FULL_MEMBER_TEAMS = {
    "Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland",
    "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe",
}


def _is_legal(delivery: dict) -> bool:
    extras = delivery.get("extras") or {}
    return not any(k in extras for k in ILLEGAL_EXTRAS)


def _is_associate_vs_associate(info: dict) -> bool:
    teams = info.get("teams") or []
    return len(teams) >= 2 and not any(team in FULL_MEMBER_TEAMS for team in teams)


def extract_innings_snapshots_from_odis(
    json_dir: str = JSON_DIR,
    csv_path: str = CSV_PATH,
    min_year: int = MIN_YEAR,
) -> pd.DataFrame:
    snapshots = []
    json_files = [f for f in os.listdir(json_dir) if f.endswith(".json")]
    print(f"Found {len(json_files)} ODI JSON files")

    kept_matches = 0
    for json_file in json_files:
        try:
            with open(os.path.join(json_dir, json_file), "r") as f:
                match_data = json.load(f)

            info = match_data.get("info") or {}
            if info.get("match_type") != MATCH_TYPE:
                continue
            if str(info.get("gender") or "").lower() != GENDER:
                continue
            if _is_associate_vs_associate(info):
                continue

            date_str = (info.get("dates") or ["Unknown"])[0]
            if date_str == "Unknown":
                continue
            try:
                match_date = datetime.strptime(str(date_str)[:10], "%Y-%m-%d")
            except ValueError:
                continue
            if match_date.year < min_year:
                continue

            scheduled_overs = int(info.get("overs") or MAX_OVERS)
            if scheduled_overs != MAX_OVERS:
                continue

            kept_matches += 1
            # This resource model predicts an innings total before a target exists.
            # Keep only the first innings; a chase has different incentives.
            for innings in (match_data.get("innings") or [])[:1]:
                if innings.get("super_over"):
                    continue
                team = innings.get("team", "")
                overs_data = innings.get("overs") or []

                final_total = 0
                for over in overs_data:
                    for delivery in over.get("deliveries") or []:
                        final_total += delivery.get("runs", {}).get("total", 0)

                legal_balls = 0
                current_score = 0
                wickets = 0
                last_snapshot_state = None

                for over in overs_data:
                    for delivery in over.get("deliveries") or []:
                        current_score += delivery.get("runs", {}).get("total", 0)
                        if "wickets" in delivery:
                            wickets += len(delivery["wickets"])

                        if not _is_legal(delivery):
                            continue

                        legal_balls += 1
                        overs_completed = legal_balls / 6.0
                        overs_remaining = MAX_OVERS - overs_completed
                        run_rate = current_score / overs_completed if overs_completed > 0 else 0

                        if legal_balls % 3 == 0 or "wickets" in delivery:
                            snapshots.append({
                                "team": team,
                                "balls_bowled": legal_balls,
                                "overs_completed": overs_completed,
                                "overs_remaining": overs_remaining,
                                "wickets": wickets,
                                "run_rate": run_rate,
                                "current_score": current_score,
                                "final_total": final_total,
                                "match_file": json_file,
                                "match_date": date_str,
                            })
                            last_snapshot_state = (legal_balls, current_score, wickets)

                # Keep a terminal state for every innings but do not duplicate one
                # already emitted at the same score, ball count, and wicket count.
                terminal_state = (legal_balls, current_score, wickets)
                if legal_balls > 0 and terminal_state != last_snapshot_state:
                    snapshots.append(
                        {
                            "team": team,
                            "balls_bowled": legal_balls,
                            "overs_completed": legal_balls / 6.0,
                            "overs_remaining": max(0, MAX_OVERS - legal_balls / 6.0),
                            "wickets": wickets,
                            "run_rate": current_score / (legal_balls / 6.0) if legal_balls else 0,
                            "current_score": current_score,
                            "final_total": final_total,
                            "match_file": json_file,
                            "match_date": date_str,
                        }
                    )
        except Exception as e:
            print(f"Error processing {json_file}: {e}")

    df = pd.DataFrame(snapshots)
    print(f"Kept {kept_matches} men's ODIs from {min_year}+")
    if df.empty:
        print("No ODI snapshots created")
        df.to_csv(csv_path, index=False)
        return df

    print(f"Created {len(df)} snapshots from {df['match_file'].nunique()} matches")
    df.to_csv(csv_path, index=False)
    print(f"Saved ODI innings snapshots to {csv_path}")
    return df


if __name__ == "__main__":
    extract_innings_snapshots_from_odis()
