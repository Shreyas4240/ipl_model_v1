"""
parse_matches.py
----------------
Parses a folder of Cricsheet-format JSON match files into a flat DataFrame
for training a T20 in-game win probability model.

One row = one legal delivery in the 2nd innings.
Label (target): 1 if the chasing team won, 0 if they lost.

Usage:
    python parse_matches.py --data_dir ./matches --output training_data.csv

    # Or from Python:
    from parse_matches import parse_all_matches
    df = parse_all_matches("./matches")
"""

import json
import os
import argparse
from collections import deque
import pandas as pd
from pathlib import Path
try:
    from score_projection import load_model_params, project_final_score
except ModuleNotFoundError:
    from scripts.score_projection import load_model_params, project_final_score

# Illegal extras that do NOT count as a legal delivery
ILLEGAL_EXTRAS = {"wides", "noballs"}

# Outcome keys that mean "no result" (abandoned, tie needing super over)
NO_RESULT_OUTCOMES = {"no result", "tie"}
MODEL_PARAMS = load_model_params(Path(__file__).resolve().parents[1])


def is_legal_delivery(delivery: dict) -> bool:
    """True if this delivery counts as one of the 120 legal balls in a T20."""
    extras = delivery.get("extras", {})
    return not any(k in extras for k in ILLEGAL_EXTRAS)


def get_phase(over: int) -> str:
    """Powerplay (0-5), middle (6-14), death (15-19)."""
    if over < 6:
        return "powerplay"
    if over < 15:
        return "middle"
    return "death"


def parse_innings2(
    innings2: dict,
    target_runs: int,
    target_overs: int,
    chasing_team_won: bool,
    match_id: str,
    venue_avg_first_innings: float,
    venue_chasing_efficiency: float,
) -> list[dict]:
    """
    Walk every delivery in the 2nd innings and build one feature row per
    legal ball.  Returns a list of dicts (later stacked into a DataFrame).
    """
    rows = []

    # Running state
    runs = 0
    wickets = 0
    legal_balls = 0
    total_legal_balls = target_overs * 6  # handles DLS (e.g. 15-over game)

    # Rolling window for momentum features (last 12 legal balls)
    last12_runs: deque[int] = deque(maxlen=12)
    last12_wickets: deque[int] = deque(maxlen=12)
    balls_since_last_wicket = 0

    for over_data in innings2["overs"]:
        over_num = over_data["over"]

        for delivery in over_data["deliveries"]:
            ball_runs = delivery["runs"]["total"]
            batter_runs = delivery["runs"]["batter"]
            is_legal = is_legal_delivery(delivery)
            ball_wickets = len(delivery.get("wickets", []))

            # Update state
            runs += ball_runs
            wickets += ball_wickets

            if is_legal:
                legal_balls += 1
                last12_runs.append(batter_runs)   # batter runs for strike rate
                last12_wickets.append(ball_wickets)

                if ball_wickets > 0:
                    balls_since_last_wicket = 0
                else:
                    balls_since_last_wicket += 1

                balls_remaining = total_legal_balls - legal_balls
                runs_needed = target_runs - runs

                # Guard against completed chase mid-over
                if runs_needed <= 0:
                    # Chasing team has already won - record this ball then stop
                    crr = (runs / legal_balls) * 6
                    rows.append(_build_row(
                        match_id, legal_balls, balls_remaining,
                        runs, wickets, runs_needed, crr, 0.0,
                        over_num, last12_runs, last12_wickets,
                        balls_since_last_wicket,
                        venue_avg_first_innings, venue_chasing_efficiency,
                        target_runs, total_legal_balls,
                        chasing_team_won,
                    ))
                    return rows

                crr = (runs / legal_balls) * 6
                rrr = (runs_needed / balls_remaining) * 6 if balls_remaining > 0 else 999.0

                rows.append(_build_row(
                    match_id, legal_balls, balls_remaining,
                    runs, wickets, runs_needed, crr, rrr,
                    over_num, last12_runs, last12_wickets,
                    balls_since_last_wicket,
                    venue_avg_first_innings, venue_chasing_efficiency,
                    target_runs, total_legal_balls,
                    chasing_team_won,
                ))

    return rows


def _build_row(
    match_id, legal_balls, balls_remaining,
    runs, wickets, runs_needed, crr, rrr,
    over_num, last12_runs, last12_wickets,
    balls_since_last_wicket,
    venue_avg_first_innings, venue_chasing_efficiency,
    target_runs, total_legal_balls,
    chasing_team_won,
) -> dict:

    wickets_remaining = 10 - wickets
    total_legal_balls_bowled = legal_balls

    # Momentum: last 12 legal balls
    momentum_runs = sum(last12_runs)
    momentum_wickets = sum(last12_wickets)
    momentum_run_rate = (momentum_runs / min(len(last12_runs), 12)) * 6 if last12_runs else 0.0

    # How target compares to venue average (pitch difficulty proxy)
    target_vs_venue_avg = target_runs - venue_avg_first_innings
    overs_completed = legal_balls / 6.0
    overs_remaining = balls_remaining / 6.0
    projected_final = project_final_score(
        current_score=runs,
        run_rate=crr,
        overs_remaining=overs_remaining,
        wickets_lost=wickets,
        overs_completed=overs_completed,
        model_params=MODEL_PARAMS,
    )
    projected_margin = projected_final - target_runs

    return {
        # Identifiers
        "match_id": match_id,
        "legal_ball": legal_balls,              # 1-indexed ball number in innings

        # Core game state
        "runs_scored": runs,
        "wickets_fallen": wickets,
        "wickets_remaining": wickets_remaining,
        "balls_remaining": balls_remaining,
        "runs_needed": runs_needed,
        "over": over_num,
        "phase": get_phase(over_num),

        # Run rates
        "crr": round(crr, 4),
        "rrr": round(rrr, 4),
        "run_rate_diff": round(crr - rrr, 4),  # positive = ahead of rate

        # Progress ratios (scale-invariant, useful for model)
        "pct_balls_used": round(total_legal_balls_bowled / total_legal_balls, 4),
        "pct_runs_scored": round(runs / target_runs, 4),
        "pct_wickets_fallen": round(wickets / 10, 4),

        # Momentum (rolling last 12 legal balls)
        "momentum_runs_12b": momentum_runs,
        "momentum_wickets_12b": momentum_wickets,
        "momentum_run_rate_12b": round(momentum_run_rate, 4),
        "balls_since_last_wicket": balls_since_last_wicket,

        # Venue features
        "venue_avg_first_innings": venue_avg_first_innings,
        "venue_chasing_efficiency": venue_chasing_efficiency,
        "target_vs_venue_avg": round(target_vs_venue_avg, 2),
        "projected_final_score": round(projected_final, 2),
        "projected_margin": round(projected_margin, 2),

        # Target context
        "target_runs": target_runs,
        "target_overs": total_legal_balls // 6,

        # Label
        "chasing_team_won": int(chasing_team_won),
    }


def parse_match(filepath: str, venue_stats: dict | None = None) -> list[dict]:
    """
    Parse a single Cricsheet JSON file.

    venue_stats: optional dict mapping venue name -> {"avg_first_innings": float,
                                                       "chasing_efficiency": float}
    If not provided, falls back to 0.0 for both (fill in from your own dataset).

    Returns list of row dicts, or [] if match is skipped.
    """
    with open(filepath) as f:
        data = json.load(f)

    info = data["info"]
    innings = data["innings"]

    # Skip conditions

    # Only T20 matches
    if info.get("match_type") != "T20":
        return []

    # Only post-2022 matches
    dates = info.get("dates", [])
    if not dates or dates[0] < "2022-01-01":
        return []

    # Need exactly 2 innings (no super overs, no abandoned after 1st)
    if len(innings) != 2:
        return []

    # Skip if any innings is flagged as a super over
    if any(inn.get("super_over") for inn in innings):
        return []

    # Skip no-result / ties (no clean label)
    outcome = info.get("outcome", {})
    if "winner" not in outcome:
        return []
    if outcome.get("result") in NO_RESULT_OUTCOMES:
        return []

    # 2nd innings must have a numeric target
    target = innings[1].get("target")
    if not target or not isinstance(target.get("runs"), int):
        return []

    target_runs = target["runs"]
    target_overs = target.get("overs", 20)

    # Determine outcome
    batting_first = innings[0]["team"]
    batting_second = innings[1]["team"]
    winner = outcome["winner"]
    chasing_team_won = winner == batting_second

    # Venue features
    venue = info.get("venue", "unknown")
    if venue_stats and venue in venue_stats:
        venue_avg = venue_stats[venue]["avg_first_innings"]
        venue_eff = venue_stats[venue]["chasing_efficiency"]
    else:
        # Fallback: use target as a rough proxy until you have precomputed stats
        venue_avg = float(target_runs)
        venue_eff = 0.0

    match_id = os.path.splitext(os.path.basename(filepath))[0]

    rows = parse_innings2(
        innings[1],
        target_runs=target_runs,
        target_overs=target_overs,
        chasing_team_won=chasing_team_won,
        match_id=match_id,
        venue_avg_first_innings=venue_avg,
        venue_chasing_efficiency=venue_eff,
    )

    return rows


def parse_all_matches(
    data_dir: str,
    venue_stats: dict | None = None,
    verbose: bool = True,
) -> pd.DataFrame:
    """
    Parse every .json file in data_dir and return a single DataFrame.

    data_dir:    folder containing Cricsheet JSON files
    venue_stats: dict of venue -> {"avg_first_innings": float,
                                   "chasing_efficiency": float}
                 If None, venue features will be set to 0.0 - replace with
                 your precomputed stats before training.
    """
    all_rows = []
    skipped = 0
    parsed = 0

    files = [f for f in os.listdir(data_dir) if f.endswith(".json")]

    for fname in sorted(files):
        filepath = os.path.join(data_dir, fname)
        try:
            rows = parse_match(filepath, venue_stats=venue_stats)
            if rows:
                all_rows.extend(rows)
                parsed += 1
            else:
                skipped += 1
        except Exception as e:
            if verbose:
                print(f"  ERROR parsing {fname}: {e}")
            skipped += 1

    if verbose:
        print(f"Parsed {parsed} matches, skipped {skipped}")
        print(f"Total rows: {len(all_rows)}")

    df = pd.DataFrame(all_rows)

    # Phase as ordered categorical (useful for tree models)
    df["phase"] = pd.Categorical(
        df["phase"],
        categories=["powerplay", "middle", "death"],
        ordered=True,
    )

    return df


# CLI
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Parse Cricsheet JSON files for win probability model")
    parser.add_argument("--data_dir", required=True, help="Folder containing match JSON files")
    parser.add_argument("--output", default="training_data.csv", help="Output CSV path")
    parser.add_argument("--venue_stats", default=None, help="Optional JSON file with venue stats")
    args = parser.parse_args()

    venue_stats = None
    if args.venue_stats and os.path.exists(args.venue_stats):
        with open(args.venue_stats) as f:
            venue_stats = json.load(f)
        print(f"Loaded venue stats for {len(venue_stats)} venues")

    print(f"Scanning {args.data_dir} ...")
    df = parse_all_matches(args.data_dir, venue_stats=venue_stats)

    df.to_csv(args.output, index=False)
    print(f"\nSaved to {args.output}")
    print(f"Shape: {df.shape}")
    print(f"\nLabel distribution:\n{df['chasing_team_won'].value_counts()}")
    print(f"\nSample rows:\n{df.head(3).to_string()}")
