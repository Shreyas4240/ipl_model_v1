"""
Train a Monte Carlo win-probability transition table for men's ODIs.

Separate from scripts/train_winprob_simulator.py. State space uses 50-over
phases, ODI required-rate buckets, and 300-ball remaining buckets.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ILLEGAL_EXTRAS = {"wides", "noballs"}
OUTCOMES = ["W", "0", "1", "2", "3", "4", "6"]
MAX_BALLS = 300
FULL_MEMBER_TEAMS = {
    "Afghanistan", "Australia", "Bangladesh", "England", "India", "Ireland",
    "New Zealand", "Pakistan", "South Africa", "Sri Lanka", "West Indies", "Zimbabwe",
}


def is_legal_delivery(delivery):
    extras = delivery.get("extras", {})
    return not any(k in extras for k in ILLEGAL_EXTRAS)


def overs_to_phase(over_number):
    if over_number < 10:
        return "pp"
    if over_number < 40:
        return "mid"
    return "death"


def rrr_bucket(rrr):
    if rrr < 4:
        return "lt4"
    if rrr < 5:
        return "4_5"
    if rrr < 6:
        return "5_6"
    if rrr < 7:
        return "6_7"
    return "ge7"


def balls_bucket(balls_remaining):
    if balls_remaining > 240:
        return "241_300"
    if balls_remaining > 180:
        return "181_240"
    if balls_remaining > 120:
        return "121_180"
    if balls_remaining > 60:
        return "61_120"
    return "1_60"


def parse_match_rows(match):
    info = match.get("info", {})
    innings = match.get("innings", [])
    if info.get("match_type") != "ODI":
        return []
    if str(info.get("gender") or "").lower() != "male":
        return []
    teams = info.get("teams") or []
    if len(teams) >= 2 and not any(team in FULL_MEMBER_TEAMS for team in teams):
        return []
    if int(info.get("overs") or 50) != 50:
        return []
    if len(innings) < 2:
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

            if is_legal_delivery(d):
                balls_remaining = MAX_BALLS - legal_balls
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
                    outcome_token = str(ball_runs if ball_runs in (0, 1, 2, 3, 4, 6) else 1)
                    if outcome_token not in OUTCOMES:
                        outcome_token = "1"

                rows.append((key, outcome_token))
                legal_balls += 1

            runs += ball_runs
            wickets += ball_wkts
            if runs >= target or wickets >= 10 or legal_balls >= MAX_BALLS:
                return rows
    return rows


def normalize(counter):
    total = sum(counter.values())
    if total <= 0:
        return {k: 0.0 for k in OUTCOMES}
    return {k: counter.get(k, 0) / total for k in OUTCOMES}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data_dir", default="odis_json")
    parser.add_argument("--output", default="data/odi_winprob_sim_model.json")
    parser.add_argument("--train_years", default="2023,2024,2025,2026")
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
            year = datetime.fromisoformat(str(date_str)[:10]).year
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
        "format": "ODI",
        "max_overs": 50,
        "max_balls": MAX_BALLS,
        "outcomes": OUTCOMES,
        "train_years": sorted(train_years),
        "matches_used": match_count,
        "global_probs": normalize(global_counts),
        "table": table,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(model, indent=2))
    print(f"saved {out_path} matches={match_count} states={len(table)}")


if __name__ == "__main__":
    main()
