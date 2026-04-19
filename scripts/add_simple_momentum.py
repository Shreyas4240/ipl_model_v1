"""
add_simple_momentum.py
---------------------
Add simple momentum features based on recent performance without LSTM.
Uses rolling windows to capture batting collapses and momentum shifts.

Usage:
    python add_simple_momentum.py --data train_data_2022_2024.csv --output train_with_momentum.csv
"""

import pandas as pd
import numpy as np
import argparse


def calculate_momentum_features(df: pd.DataFrame, window_size: int = 6) -> pd.DataFrame:
    """
    Calculate momentum features using rolling windows.
    
    Args:
        df: DataFrame with match data
        window_size: Number of recent balls to consider (6-8 recommended)
    
    Returns:
        DataFrame with added momentum features
    """
    df_with_momentum = df.copy()
    
    # Sort by match and ball for proper rolling calculations
    df_with_momentum = df_with_momentum.sort_values(['match_id', 'legal_ball'])
    
    # Initialize momentum features
    df_with_momentum['recent_runs_rate'] = 0.0
    df_with_momentum['recent_wicket_rate'] = 0.0
    df_with_momentum['momentum_score'] = 0.5  # Neutral momentum
    df_with_momentum['batting_pressure'] = 0.0
    
    # Calculate momentum for each match
    for match_id, match_df in df_with_momentum.groupby('match_id'):
        match_df = match_df.sort_values('legal_ball')
        
        # Calculate rolling metrics
        for i in range(len(match_df)):
            if i == 0:
                # First ball - use neutral values
                df_with_momentum.loc[match_df.index[i], 'recent_runs_rate'] = 6.0
                df_with_momentum.loc[match_df.index[i], 'recent_wicket_rate'] = 0.0
                df_with_momentum.loc[match_df.index[i], 'momentum_score'] = 0.5
                df_with_momentum.loc[match_df.index[i], 'batting_pressure'] = 0.0
            else:
                # Get recent window
                start_idx = max(0, i - window_size + 1)
                recent_df = match_df.iloc[start_idx:i+1]
                
                # Recent runs per ball
                recent_runs = recent_df['runs_scored'].iloc[-1] - (recent_df['runs_scored'].iloc[0] if len(recent_df) > 1 else 0)
                recent_balls = len(recent_df)
                recent_runs_rate = (recent_runs / recent_balls) * 6 if recent_balls > 0 else 6.0
                
                # Recent wickets per ball  
                recent_wickets = recent_df['wickets_fallen'].iloc[-1] - (recent_df['wickets_fallen'].iloc[0] if len(recent_df) > 1 else 0)
                recent_wicket_rate = recent_wickets / recent_balls if recent_balls > 0 else 0.0
                
                # Current required rate
                current_rrr = match_df.iloc[i]['rrr']
                
                # Momentum score (0-1, higher = better momentum)
                # Factor in recent run rate vs required rate
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
                
                # Update features
                df_with_momentum.loc[match_df.index[i], 'recent_runs_rate'] = recent_runs_rate
                df_with_momentum.loc[match_df.index[i], 'recent_wicket_rate'] = recent_wicket_rate
                df_with_momentum.loc[match_df.index[i], 'momentum_score'] = momentum
                df_with_momentum.loc[match_df.index[i], 'batting_pressure'] = pressure
    
    return df_with_momentum


def main():
    parser = argparse.ArgumentParser(description="Add simple momentum features")
    parser.add_argument("--data", required=True, help="Input CSV file")
    parser.add_argument("--output", required=True, help="Output CSV file")
    parser.add_argument("--window_size", type=int, default=6, help="Window size for momentum")
    
    args = parser.parse_args()
    
    print(f"Loading data from {args.data}...")
    df = pd.read_csv(args.data)
    print(f"Data shape: {df.shape}")
    
    print(f"Adding momentum features with window size {args.window_size}...")
    df_with_momentum = calculate_momentum_features(df, args.window_size)
    
    # Display momentum statistics
    print(f"\nMomentum feature statistics:")
    print(df_with_momentum[['momentum_score', 'recent_runs_rate', 'recent_wicket_rate', 'batting_pressure']].describe())
    
    # Analyze momentum vs actual wins
    print(f"\nMomentum vs actual wins:")
    momentum_bins = pd.qcut(df_with_momentum['momentum_score'], 5, labels=['Very Low', 'Low', 'Medium', 'High', 'Very High'])
    momentum_analysis = df_with_momentum.groupby(momentum_bins)['chasing_team_won'].agg(['mean', 'count'])
    print(momentum_analysis)
    
    # Save enhanced dataset
    df_with_momentum.to_csv(args.output, index=False)
    print(f"\nEnhanced dataset saved to {args.output}")
    print(f"New shape: {df_with_momentum.shape}")


if __name__ == "__main__":
    main()
