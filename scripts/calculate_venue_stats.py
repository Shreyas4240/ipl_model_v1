"""
calculate_venue_stats.py
-------------------------
Calculate venue-specific statistics from Cricsheet data for win probability model.

Computes:
- Average first innings total by venue
- Chasing efficiency (wins when chasing / total matches at venue)

Usage:
    python calculate_venue_stats.py --data_dir ./matches --output venue_stats.json
"""

import json
import os
import argparse
from collections import defaultdict
import pandas as pd


def calculate_venue_stats(data_dir: str) -> dict:
    """
    Calculate venue-specific statistics from Cricsheet JSON files.
    
    Returns:
        Dict mapping venue -> {"avg_first_innings": float, "chasing_efficiency": float}
    """
    venue_stats = defaultdict(lambda: {"first_innings_totals": [], "chasing_results": []})
    
    files = [f for f in os.listdir(data_dir) if f.endswith(".json")]
    print(f"Processing {len(files)} match files...")
    
    for fname in files:
        filepath = os.path.join(data_dir, fname)
        try:
            with open(filepath) as f:
                data = json.load(f)
            
            info = data["info"]
            innings = data["innings"]
            
            # Skip non-T20 or incomplete matches
            if info.get("match_type") != "T20":
                continue
            if len(innings) != 2:
                continue
            
            # Only post-2022 matches
            dates = info.get("dates", [])
            if not dates or dates[0] < "2022-01-01":
                continue
            
            # Get venue
            venue = info.get("venue", "unknown")
            
            # Calculate first innings total
            first_innings = innings[0]
            first_innings_runs = 0
            for over in first_innings.get("overs", []):
                for delivery in over.get("deliveries", []):
                    first_innings_runs += delivery["runs"]["total"]
            
            venue_stats[venue]["first_innings_totals"].append(first_innings_runs)
            
            # Determine chasing result
            outcome = info.get("outcome", {})
            if "winner" in outcome:
                batting_first = innings[0]["team"]
                batting_second = innings[1]["team"]
                winner = outcome["winner"]
                
                # 1 if chasing team won, 0 if they lost
                chasing_won = int(winner == batting_second)
                venue_stats[venue]["chasing_results"].append(chasing_won)
                
        except Exception as e:
            print(f"Error processing {fname}: {e}")
            continue
    
    # Calculate final statistics
    final_stats = {}
    for venue, stats in venue_stats.items():
        first_totals = stats["first_innings_totals"]
        chase_results = stats["chasing_results"]
        
        # Only include venues with sufficient data
        if len(first_totals) >= 3 and len(chase_results) >= 3:
            avg_first_innings = sum(first_totals) / len(first_totals)
            chasing_efficiency = sum(chase_results) / len(chase_results)
            
            final_stats[venue] = {
                "avg_first_innings": round(avg_first_innings, 1),
                "chasing_efficiency": round(chasing_efficiency, 3),
                "matches_sample": len(first_totals)
            }
    
    return final_stats


def main():
    parser = argparse.ArgumentParser(description="Calculate venue statistics for win probability model")
    parser.add_argument("--data_dir", required=True, help="Folder containing Cricsheet JSON files")
    parser.add_argument("--output", default="venue_stats.json", help="Output JSON file")
    args = parser.parse_args()
    
    print(f"Calculating venue statistics from {args.data_dir}...")
    
    venue_stats = calculate_venue_stats(args.data_dir)
    
    # Save to JSON
    with open(args.output, "w") as f:
        json.dump(venue_stats, f, indent=2)
    
    print(f"\nVenue statistics saved to {args.output}")
    print(f"Calculated stats for {len(venue_stats)} venues")
    
    # Display top venues
    sorted_venues = sorted(venue_stats.items(), key=lambda x: x[1]["matches_sample"], reverse=True)
    print("\nTop venues by sample size:")
    for venue, stats in sorted_venues[:10]:
        print(f"  {venue}: avg={stats['avg_first_innings']}, chase_eff={stats['chasing_efficiency']}, n={stats['matches_sample']}")


if __name__ == "__main__":
    main()
