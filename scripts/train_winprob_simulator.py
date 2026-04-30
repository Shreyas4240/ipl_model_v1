"""
Train a Cricinfo-style simulation win probability model.

Builds conditional ball-outcome distributions from historical IPL chases and
stores them as a compact JSON transition table for Monte Carlo rollouts.
"""

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from datetime import datetime


ILLEGAL_EXTRAS = {"wides", "noballs"}
OUTCOMES = ["W", "0", "1", "2", "3", "4", "6"]


def is_legal_delivery(delivery):
    extras = delivery.get("extras", {})
    return not any(k in extras for k in ILLEGAL_EXTRAS)


def overs_to_phase(over_number):
    if over_number < 6:
        return "pp"
    if over_number < 15:
        return "mid"
    return "death"


def rrr_bucket(rrr):
    if rrr < 6:
        return "lt6"
    if rrr < 8:
        return "6_8"
    if rrr < 10:
        return "8_10"
    if rrr < 12:
        return "10_12"
    return "ge12"


def balls_bucket(balls_remaining):
    if balls_remaining > 90:
        return "91_120"
    if balls_remaining > 60:
        return "61_90"
    if balls_remaining > 30:
        return "31_60"
    return "1_30"


def parse_match_rows(match):
    info = match.get("info", {})
    innings = match.get("innings", [])
    if info.get("match_type") != "T20" or len(innings) < 2:
        return []
    outcome = info.get("outcome", {})
    if "winner" not in outcome:
        return []

    inn1 = innings[0]
    inn2 = innings[1]
    first_total = 0
    for over in inn1.get("overs", []):
        for d in over.get("deliveries", []):
            first_total += d["runs"]["total"]
    target = first_total + 1

    rows = []
    runs = 0
    wickets = 0
    legal_balls = 0
    for over in inn2.get("overs", []):
        over_no = int(over.get("over", 0))
        for d in over.get("deliveries", []):
            ball_runs = int(d["runs"]["total"])
            ball_wkts = len(d.get("wickets", []))

            # state before this legal ball
            if is_legal_delivery(d):
                balls_remaining = 120 - legal_balls
                runs_needed = max(0, target - runs)
                if balls_remaining <= 0:
                    continue
                rrr = (runs_needed / balls_remaining) * 6.0
                key = (
                    overs_to_phase(over_no),
                    str(min(10, wickets)),
                    rrr_bucket(rrr),
                    balls_bucket(balls_remaining),
                )

                if ball_wkts > 0:
                    outcome_token = "W"
                else:
                    # cap rare high-run balls to 6 bucket for stability
                    outcome_token = str(ball_runs if ball_runs in (0, 1, 2, 3, 4, 6) else 1)
                    if outcome_token not in OUTCOMES:
                        outcome_token = "1"

                rows.append((key, outcome_token))
                legal_balls += 1

            runs += ball_runs
            wickets += ball_wkts
            if runs >= target or wickets >= 10 or legal_balls >= 120:
                return rows
    return rows


def normalize(counter):
    total = sum(counter.values())
    if total <= 0:
        return {k: 0.0 for k in OUTCOMES}
    return {k: counter.get(k, 0) / total for k in OUTCOMES}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data_dir", required=True)
    parser.add_argument("--output", default="data/winprob_sim_model.json")
    parser.add_argument("--train_years", default="2023,2024,2025")
    args = parser.parse_args()

    train_years = {int(y.strip()) for y in args.train_years.split(",")}
    path = Path(args.data_dir)

    by_key = defaultdict(Counter)
    global_counts = Counter()
    match_count = 0

    for fp in sorted(path.glob("*.json")):
        try:
            match = json.loads(fp.read_text())
            date_str = (match.get("info", {}).get("dates") or ["1900-01-01"])[0]
            year = datetime.fromisoformat(date_str).year
            if year not in train_years:
                continue
            rows = parse_match_rows(match)
            if not rows:
                continue
            match_count += 1
            for key, out in rows:
                by_key[key][out] += 1
                global_counts[out] += 1
        except Exception:
            continue

    table = {}
    for key, ctr in by_key.items():
        table["|".join(key)] = {
            "probs": normalize(ctr),
            "n": int(sum(ctr.values())),
        }

    model = {
        "outcomes": OUTCOMES,
        "train_years": sorted(train_years),
        "matches_used": match_count,
        "global_probs": normalize(global_counts),
        "table": table,
    }

    out_path = Path(args.output)
    out_path.write_text(json.dumps(model, indent=2))
    print(f"saved {out_path} matches={match_count} states={len(table)}")


if __name__ == "__main__":
    main()
