"""
parse_matches_by_year.py
----------------------
Parse Cricsheet matches by year for proper train/test split.
Train on 2022-2024, test on 2025.

Usage:
    python parse_matches_by_year.py --data_dir ./matches --train_years 2022,2023,2024 --test_years 2025
"""

import json
import os
import argparse
import pandas as pd
from parse_matches import parse_match, NO_RESULT_OUTCOMES, ILLEGAL_EXTRAS, is_legal_delivery, get_phase
from collections import deque


def parse_matches_by_year(data_dir: str, train_years: list, test_years: list, venue_stats: dict = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Parse matches by year for train/test split.
    
    Returns:
        train_df: DataFrame with training years data
        test_df: DataFrame with test years data
    """
    train_rows = []
    test_rows = []
    train_skipped = 0
    test_skipped = 0
    train_parsed = 0
    test_parsed = 0
    
    files = [f for f in os.listdir(data_dir) if f.endswith(".json")]
    
    for fname in sorted(files):
        filepath = os.path.join(data_dir, fname)
        
        # Get year first to decide which dataset it belongs to
        try:
            with open(filepath) as f:
                data = json.load(f)
            
            info = data["info"]
            
            # Skip non-T20 matches
            if info.get("match_type") != "T20":
                continue
            
            # Get year
            dates = info.get("dates", [])
            if not dates or dates[0] < "2022-01-01":
                continue
                
            year = dates[0].split("-")[0]
            
            # Determine if this is train or test
            is_train = year in train_years
            is_test = year in test_years
            
            if not (is_train or is_test):
                continue
            
            # Parse the match
            rows = parse_match(filepath, venue_stats)
            
            if rows:
                if is_train:
                    train_rows.extend(rows)
                    train_parsed += 1
                else:
                    test_rows.extend(rows)
                    test_parsed += 1
            else:
                if is_train:
                    train_skipped += 1
                else:
                    test_skipped += 1
                    
        except Exception as e:
            print(f"Error processing {fname}: {e}")
            if year in train_years:
                train_skipped += 1
            else:
                test_skipped += 1
            continue
    
    print(f"Training years {train_years}:")
    print(f"  Parsed: {train_parsed}, Skipped: {train_skipped}")
    print(f"  Rows: {len(train_rows)}")
    
    print(f"Test years {test_years}:")
    print(f"  Parsed: {test_parsed}, Skipped: {test_skipped}")
    print(f"  Rows: {len(test_rows)}")
    
    # Create DataFrames
    train_df = pd.DataFrame(train_rows)
    test_df = pd.DataFrame(test_rows)
    
    # Add phase as categorical
    for df in [train_df, test_df]:
        if "phase" in df.columns:
            df["phase"] = pd.Categorical(
                df["phase"],
                categories=["powerplay", "middle", "death"],
                ordered=True,
            )
    
    return train_df, test_df


def main():
    parser = argparse.ArgumentParser(description="Parse matches by year for train/test split")
    parser.add_argument("--data_dir", required=True, help="Folder containing Cricsheet JSON files")
    parser.add_argument("--train_years", default="2022,2023,2024", help="Training years (comma-separated)")
    parser.add_argument("--test_years", default="2025", help="Test years (comma-separated)")
    parser.add_argument("--venue_stats", default=None, help="Optional JSON file with venue stats")
    parser.add_argument("--train_output", default="train_data.csv", help="Training data output")
    parser.add_argument("--test_output", default="test_data.csv", help="Test data output")
    
    args = parser.parse_args()
    
    # Parse years
    train_years = [y.strip() for y in args.train_years.split(",")]
    test_years = [y.strip() for y in args.test_years.split(",")]
    
    # Load venue stats
    venue_stats = None
    if args.venue_stats and os.path.exists(args.venue_stats):
        with open(args.venue_stats) as f:
            venue_stats = json.load(f)
        print(f"Loaded venue stats for {len(venue_stats)} venues")
    
    print(f"Parsing matches from {args.data_dir}...")
    print(f"Training years: {train_years}")
    print(f"Test years: {test_years}")
    
    # Parse by year
    train_df, test_df = parse_matches_by_year(args.data_dir, train_years, test_years, venue_stats)
    
    # Save datasets
    train_df.to_csv(args.train_output, index=False)
    test_df.to_csv(args.test_output, index=False)
    
    print(f"\nSaved training data to {args.train_output}")
    print(f"Saved test data to {args.test_output}")
    
    # Display statistics
    print(f"\nTraining data shape: {train_df.shape}")
    print(f"Training label distribution:\n{train_df['chasing_team_won'].value_counts(normalize=True)}")
    
    print(f"\nTest data shape: {test_df.shape}")
    print(f"Test label distribution:\n{test_df['chasing_team_won'].value_counts(normalize=True)}")


if __name__ == "__main__":
    main()
