"""
predict_enhanced_winprob.py
---------------------------
Use enhanced XGBoost model with momentum features for win probability prediction.

This script calculates momentum features from recent ball-by-ball data and provides
real-time win probability predictions.

Usage:
    python predict_enhanced_winprob.py --model base_enhanced_model.pkl --runs 120 --wickets 2 --overs 15.3 --target 190
"""

import pickle
import numpy as np
import pandas as pd
import argparse
from typing import Dict, Optional, List
from pathlib import Path
try:
    from score_projection import load_model_params, project_final_score
except ModuleNotFoundError:
    from scripts.score_projection import load_model_params, project_final_score

# Feature columns (must match training)
FEATURE_COLS = [
    "legal_ball",
    "runs_scored", "wickets_fallen", "wickets_remaining", "balls_remaining", "runs_needed",
    "over", "crr", "rrr", "run_rate_diff",
    "pct_balls_used", "pct_runs_scored", "pct_wickets_fallen",
    "momentum_runs_12b", "momentum_wickets_12b", "momentum_run_rate_12b",
    "balls_since_last_wicket",
    "venue_avg_first_innings", "venue_chasing_efficiency", "target_vs_venue_avg",
    "projected_final_score", "projected_margin",
    "target_runs", "target_overs",
    "momentum_score", "recent_runs_rate", "recent_wicket_rate", "batting_pressure"
]

# Phase mapping
PHASE_MAP = {"powerplay": 0, "middle": 1, "death": 2}

# Default venue stats (IPL averages)
DEFAULT_VENUE_STATS = {
    "avg_first_innings": 193,
    "chasing_efficiency": 0.52
}
MODEL_PARAMS = load_model_params(Path(__file__).resolve().parents[1])


def overs_to_legal_balls(overs: float) -> int:
    whole = int(overs)
    frac = int(round((overs - whole) * 10))
    if frac < 0:
        frac = 0
    if frac > 5:
        frac = 5
    return whole * 6 + frac


def get_phase(over: int) -> str:
    """Get match phase from over number."""
    if over < 6:
        return "powerplay"
    if over < 15:
        return "middle"
    return "death"


def calculate_momentum_features(current_state: Dict, recent_balls: List[Dict], window_size: int = 6) -> Dict:
    """
    Calculate momentum features from recent ball-by-ball data.
    
    Args:
        current_state: Current match state (runs, wickets, overs, target)
        recent_balls: List of recent balls with runs/wickets data
        window_size: Number of recent balls to consider
    
    Returns:
        Dictionary with momentum features
    """
    if not recent_balls or len(recent_balls) == 0:
        # No recent data - use neutral values
        return {
            "momentum_score": 0.5,
            "recent_runs_rate": 6.0,
            "recent_wicket_rate": 0.0,
            "batting_pressure": 0.0
        }
    
    # Use only the most recent window_size balls
    recent_balls = recent_balls[-window_size:]
    
    # Calculate recent metrics
    total_runs = sum(ball.get("runs", 0) for ball in recent_balls)
    total_wickets = sum(ball.get("wickets", 0) for ball in recent_balls)
    num_balls = len(recent_balls)
    
    # Recent runs per ball
    recent_runs_rate = (total_runs / num_balls) * 6 if num_balls > 0 else 6.0
    
    # Recent wickets per ball
    recent_wicket_rate = total_wickets / num_balls if num_balls > 0 else 0.0
    
    # Current required rate
    current_rrr = current_state.get("required_rr", 8.0)
    
    # Momentum score (0-1, higher = better momentum)
    rr_diff = recent_runs_rate - current_rrr
    momentum = 0.5 + (rr_diff / 20.0)  # Scale difference
    
    # Penalty for recent wickets
    wicket_penalty = recent_wicket_rate * 0.3
    momentum = max(0.0, min(1.0, momentum - wicket_penalty))
    
    # Batting pressure (0-1, higher = more pressure)
    pressure = 0.0
    if current_rrr > 12:
        pressure = min(1.0, (current_rrr - 12) / 8.0)
    if recent_wicket_rate > 0.2:  # 1 wicket per 5 balls
        pressure = max(pressure, 0.7)
    
    return {
        "momentum_score": momentum,
        "recent_runs_rate": recent_runs_rate,
        "recent_wicket_rate": recent_wicket_rate,
        "batting_pressure": pressure
    }


def prepare_enhanced_features(
    runs: int,
    wickets: int,
    overs: float,
    target: int,
    venue_stats: Optional[Dict] = None,
    recent_balls: Optional[List[Dict]] = None
) -> pd.DataFrame:
    """
    Prepare feature DataFrame for enhanced prediction with momentum.
    
    Args:
        runs: Current runs scored by chasing team
        wickets: Wickets fallen for chasing team
        overs: Overs completed (e.g., 15.3)
        target: Target runs to win
        venue_stats: Optional venue-specific stats
        recent_balls: Optional list of recent balls for momentum
    
    Returns:
        DataFrame with features for prediction
    """
    venue = venue_stats or DEFAULT_VENUE_STATS
    
    # Calculate derived features
    legal_balls = overs_to_legal_balls(overs)
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
    
    # Legacy momentum features (defaults)
    momentum_runs_12b = min(runs, 12 * 6)
    momentum_wickets_12b = min(wickets, 2)
    momentum_run_rate_12b = crr
    balls_since_last_wicket = 12
    
    # Venue features
    venue_avg_first_innings = venue["avg_first_innings"]
    venue_chasing_efficiency = venue["chasing_efficiency"]
    target_vs_venue_avg = target - venue_avg_first_innings
    projected_final_score = project_final_score(
        current_score=runs,
        run_rate=crr,
        overs_remaining=max(0.0, balls_remaining / 6.0),
        wickets_lost=wickets,
        overs_completed=legal_balls / 6.0,
        model_params=MODEL_PARAMS,
    )
    projected_margin = projected_final_score - target
    
    # Calculate new momentum features
    current_state = {
        "runs": runs,
        "wickets": wickets,
        "overs": overs,
        "target": target,
        "required_rr": rrr
    }
    
    momentum_features = calculate_momentum_features(current_state, recent_balls or [])
    
    # Target context
    target_overs = 20  # Standard T20
    
    # Create feature dictionary in exact training order
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
        "projected_final_score": round(projected_final_score, 2),
        "projected_margin": round(projected_margin, 2),
        "target_runs": target,
        "target_overs": target_overs,
        "momentum_score": momentum_features["momentum_score"],
        "recent_runs_rate": momentum_features["recent_runs_rate"],
        "recent_wicket_rate": momentum_features["recent_wicket_rate"],
        "batting_pressure": momentum_features["batting_pressure"],
        "phase": PHASE_MAP[get_phase(int(overs))]
    }
    
    return pd.DataFrame([features])


def load_model(model_path: str):
    """Load trained XGBoost model."""
    with open(model_path, "rb") as f:
        return pickle.load(f)


def predict_enhanced_win_probability(
    model,
    runs: int,
    wickets: int,
    overs: float,
    target: int,
    venue_stats: Optional[Dict] = None,
    recent_balls: Optional[List[Dict]] = None
) -> Dict:
    """
    Predict win probability with momentum features.
    
    Returns:
        Dictionary with win probability and metadata
    """
    # Prepare features
    X = prepare_enhanced_features(runs, wickets, overs, target, venue_stats, recent_balls)
    
    # Make prediction
    win_prob = model.predict_proba(X)[0, 1]  # Probability of chasing team winning
    
    # Get momentum features for display
    momentum = calculate_momentum_features(
        {"runs": runs, "wickets": wickets, "overs": overs, "target": target, "required_rr": (target - runs) / (120 - overs * 6) * 6 if overs < 20 else 999},
        recent_balls or []
    )
    
    # Return comprehensive result
    return {
        "chasing_team_win_prob": round(win_prob * 100, 2),
        "defending_team_win_prob": round((1 - win_prob) * 100, 2),
        "current_rr": round((runs / (overs * 6)) * 6, 2) if overs > 0 else 0,
        "required_rr": round(((target - runs) / (120 - overs * 6)) * 6, 2) if overs < 20 else 0,
        "runs_needed": max(0, target - runs),
        "balls_remaining": max(0, 120 - int(overs * 6)),
        "momentum_score": round(momentum["momentum_score"] * 100, 1),
        "recent_runs_rate": round(momentum["recent_runs_rate"], 1),
        "batting_pressure": round(momentum["batting_pressure"] * 100, 1),
        "match_state": {
            "runs": runs,
            "wickets": wickets,
            "overs": overs,
            "target": target
        }
    }


def main():
    parser = argparse.ArgumentParser(description="Predict win probability using enhanced XGBoost model")
    parser.add_argument("--model", required=True, help="Trained model pickle file")
    parser.add_argument("--runs", type=int, required=True, help="Current runs scored")
    parser.add_argument("--wickets", type=int, required=True, help="Wickets fallen")
    parser.add_argument("--overs", type=float, required=True, help="Overs completed (e.g., 15.3)")
    parser.add_argument("--target", type=int, required=True, help="Target runs to win")
    parser.add_argument("--venue_avg", type=float, default=193, help="Venue average first innings")
    parser.add_argument("--chase_eff", type=float, default=0.52, help="Venue chasing efficiency")
    
    args = parser.parse_args()
    
    # Load model
    print(f"Loading enhanced model from {args.model}...")
    model = load_model(args.model)
    
    # Prepare venue stats
    venue_stats = {
        "avg_first_innings": args.venue_avg,
        "chasing_efficiency": args.chase_eff
    }
    
    # Example recent balls (for demonstration - in production, this would come from live data)
    recent_balls = [
        {"runs": 1, "wickets": 0},  # Last ball
        {"runs": 4, "wickets": 0},  # 2 balls ago
        {"runs": 0, "wickets": 0},  # 3 balls ago
        {"runs": 1, "wickets": 1},  # 4 balls ago (wicket!)
        {"runs": 6, "wickets": 0},  # 5 balls ago
        {"runs": 2, "wickets": 0},  # 6 balls ago
    ]
    
    # Make prediction
    result = predict_enhanced_win_probability(
        model, args.runs, args.wickets, args.overs, args.target, venue_stats, recent_balls
    )
    
    # Display results
    print("\n=== Enhanced Win Probability Prediction ===")
    print(f"Chasing team: {result['chasing_team_win_prob']}%")
    print(f"Defending team: {result['defending_team_win_prob']}%")
    print(f"Current RR: {result['current_rr']}")
    print(f"Required RR: {result['required_rr']}")
    print(f"Runs needed: {result['runs_needed']}")
    print(f"Balls remaining: {result['balls_remaining']}")
    print(f"Momentum Score: {result['momentum_score']}%")
    print(f"Recent Runs Rate: {result['recent_runs_rate']}")
    print(f"Batting Pressure: {result['batting_pressure']}%")


if __name__ == "__main__":
    main()
