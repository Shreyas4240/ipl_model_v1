"""
predict_winprob.py
------------------
Use trained XGBoost model to predict win probability for live matches.

This script can be called from the live API to provide real-time win probability
predictions based on current match state.

Usage:
    python predict_winprob.py --model model.pkl --runs 120 --wickets 2 --overs 15.3 --target 190
"""

import pickle
import numpy as np
import pandas as pd
import argparse
from typing import Dict, Optional

# Feature columns (must match training)
FEATURE_COLS = [
    "legal_ball",
    "runs_scored", "wickets_fallen", "wickets_remaining", "balls_remaining", "runs_needed",
    "over", "crr", "rrr", "run_rate_diff",
    "pct_balls_used", "pct_runs_scored", "pct_wickets_fallen",
    "momentum_runs_12b", "momentum_wickets_12b", "momentum_run_rate_12b",
    "balls_since_last_wicket",
    "venue_avg_first_innings", "venue_chasing_efficiency", "target_vs_venue_avg",
    "target_runs", "target_overs"
]

# Phase mapping
PHASE_MAP = {"powerplay": 0, "middle": 1, "death": 2}

# Default venue stats (IPL averages)
DEFAULT_VENUE_STATS = {
    "avg_first_innings": 193,
    "chasing_efficiency": 0.52
}


def get_phase(over: int) -> str:
    """Get match phase from over number."""
    if over < 6:
        return "powerplay"
    if over < 15:
        return "middle"
    return "death"


def prepare_prediction_features(
    runs: int,
    wickets: int,
    overs: float,
    target: int,
    venue_stats: Optional[Dict] = None,
    momentum_data: Optional[Dict] = None
) -> pd.DataFrame:
    """
    Prepare feature DataFrame for prediction.
    
    Args:
        runs: Current runs scored by chasing team
        wickets: Wickets fallen for chasing team
        overs: Overs completed (e.g., 15.3)
        target: Target runs to win
        venue_stats: Optional venue-specific stats
        momentum_data: Optional momentum features from recent balls
    
    Returns:
        DataFrame with features for prediction
    """
    venue = venue_stats or DEFAULT_VENUE_STATS
    
    # Calculate derived features
    legal_balls = int(overs * 6) + int((overs % 1) * 10)  # Approximate legal balls
    balls_remaining = 120 - legal_balls
    runs_needed = target - runs
    wickets_remaining = 10 - wickets
    
    # Run rates
    crr = (runs / legal_balls) * 6 if legal_balls > 0 else 0
    rrr = (runs_needed / balls_remaining) * 6 if balls_remaining > 0 else 999
    run_rate_diff = crr - rrr
    
    # Progress ratios
    pct_balls_used = legal_balls / 120
    pct_runs_scored = runs / target if target > 0 else 0
    pct_wickets_fallen = wickets / 10
    
    # Momentum features (use defaults if not provided)
    if momentum_data:
        momentum_runs_12b = momentum_data.get("runs_12b", 0)
        momentum_wickets_12b = momentum_data.get("wickets_12b", 0)
        momentum_run_rate_12b = momentum_data.get("run_rate_12b", 0)
        balls_since_last_wicket = momentum_data.get("balls_since_wicket", 0)
    else:
        # Default momentum values
        momentum_runs_12b = min(runs, 12 * 6)  # Reasonable default
        momentum_wickets_12b = min(wickets, 2)
        momentum_run_rate_12b = crr
        balls_since_last_wicket = 12  # Default assumption
    
    # Venue features
    venue_avg_first_innings = venue["avg_first_innings"]
    venue_chasing_efficiency = venue["chasing_efficiency"]
    target_vs_venue_avg = target - venue_avg_first_innings
    
    # Target context
    target_overs = 20  # Standard T20
    
    # Create feature dictionary
    features = {
        "legal_ball": legal_balls,
        "runs_scored": runs,
        "wickets_fallen": wickets,
        "wickets_remaining": wickets_remaining,
        "balls_remaining": balls_remaining,
        "runs_needed": runs_needed,
        "over": int(overs),
        "crr": round(crr, 4),
        "rrr": round(rrr, 4),
        "run_rate_diff": round(run_rate_diff, 4),
        "pct_balls_used": round(pct_balls_used, 4),
        "pct_runs_scored": round(pct_runs_scored, 4),
        "pct_wickets_fallen": round(pct_wickets_fallen, 4),
        "momentum_runs_12b": momentum_runs_12b,
        "momentum_wickets_12b": momentum_wickets_12b,
        "momentum_run_rate_12b": round(momentum_run_rate_12b, 4),
        "balls_since_last_wicket": balls_since_last_wicket,
        "venue_avg_first_innings": venue_avg_first_innings,
        "venue_chasing_efficiency": venue_chasing_efficiency,
        "target_vs_venue_avg": round(target_vs_venue_avg, 2),
        "target_runs": target,
        "target_overs": target_overs,
        "phase": PHASE_MAP[get_phase(int(overs))]
    }
    
    return pd.DataFrame([features])


def load_model(model_path: str):
    """Load trained XGBoost model."""
    with open(model_path, "rb") as f:
        return pickle.load(f)


def predict_win_probability(
    model,
    runs: int,
    wickets: int,
    overs: float,
    target: int,
    venue_stats: Optional[Dict] = None,
    momentum_data: Optional[Dict] = None
) -> Dict:
    """
    Predict win probability for current match state.
    
    Returns:
        Dictionary with win probability and metadata
    """
    # Prepare features
    X = prepare_prediction_features(runs, wickets, overs, target, venue_stats, momentum_data)
    
    # Make prediction
    win_prob = model.predict_proba(X)[0, 1]  # Probability of chasing team winning
    
    # Return comprehensive result
    return {
        "chasing_team_win_prob": round(win_prob * 100, 2),
        "defending_team_win_prob": round((1 - win_prob) * 100, 2),
        "current_rr": round((runs / (overs * 6)) * 6, 2) if overs > 0 else 0,
        "required_rr": round(((target - runs) / (120 - overs * 6)) * 6, 2) if overs < 20 else 0,
        "runs_needed": max(0, target - runs),
        "balls_remaining": max(0, 120 - int(overs * 6)),
        "match_state": {
            "runs": runs,
            "wickets": wickets,
            "overs": overs,
            "target": target
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Predict win probability using XGBoost model")
    parser.add_argument("--model", required=True, help="Trained model pickle file")
    parser.add_argument("--runs", type=int, required=True, help="Current runs scored")
    parser.add_argument("--wickets", type=int, required=True, help="Wickets fallen")
    parser.add_argument("--overs", type=float, required=True, help="Overs completed (e.g., 15.3)")
    parser.add_argument("--target", type=int, required=True, help="Target runs to win")
    parser.add_argument("--venue_avg", type=float, default=193, help="Venue average first innings")
    parser.add_argument("--chase_eff", type=float, default=0.52, help="Venue chasing efficiency")
    
    args = parser.parse_args()
    
    # Load model
    print(f"Loading model from {args.model}...")
    model = load_model(args.model)
    
    # Prepare venue stats
    venue_stats = {
        "avg_first_innings": args.venue_avg,
        "chasing_efficiency": args.chase_eff
    }
    
    # Make prediction
    result = predict_win_probability(
        model, args.runs, args.wickets, args.overs, args.target, venue_stats
    )
    
    # Display results
    print("\n=== Win Probability Prediction ===")
    print(f"Chasing team: {result['chasing_team_win_prob']}%")
    print(f"Defending team: {result['defending_team_win_prob']}%")
    print(f"Current RR: {result['current_rr']}")
    print(f"Required RR: {result['required_rr']}")
    print(f"Runs needed: {result['runs_needed']}")
    print(f"Balls remaining: {result['balls_remaining']}")


if __name__ == "__main__":
    main()
