import json
import os
from pathlib import Path

def find_unfinished_innings():
    ipl_dir = Path("ipl_male_json")
    json_files = list(ipl_dir.glob("*.json"))
    unfinished = []

    for fp in json_files:
        try:
            with open(fp, 'r') as f:
                data = json.load(f)
            
            info = data.get("info", {})
            # Only focus on T20 matches
            if info.get("match_type") != "T20":
                continue
                
            innings = data.get("innings", [])
            if not innings:
                continue
                
            # Check first innings
            inn1 = innings[0]
            overs_data = inn1.get("overs", [])
            
            # Calculate total runs and wickets
            wickets = 0
            legal_balls = 0
            for over in overs_data:
                for delivery in over.get("deliveries", []):
                    wickets += len(delivery.get("wickets", []))
                    # Check if legal ball (no wide/no-ball)
                    extras = delivery.get("extras", {})
                    if "wides" not in extras and "noballs" not in extras:
                        legal_balls += 1
            
            total_overs = legal_balls / 6.0
            
            # Criteria for finished: 10 wickets OR ~20 overs (handling slightly shorter for rain reduction sometimes but usually it's the 'abandoned' ones we want)
            # If the innings ended with < 10 wickets AND < 19.5 overs (to be safe), it might be abandoned or rain-reduced.
            # However, if it's a rain-reduced game that actually FINISHED (e.g. 5 over match), cricsheet usually reflects that.
            # But the user specifically wants games abandoned/unfinished in the first innings.
            
            is_all_out = (wickets >= 10)
            is_full_overs = (total_overs >= 19.5)
            
            if not is_all_out and not is_full_overs:
                # Potential unfinished innings
                date = info.get("dates", ["Unknown"])[0]
                teams = " vs ".join(info.get("teams", ["Unknown", "Unknown"]))
                unfinished.append({
                    "match_file": fp.name,
                    "date": date,
                    "teams": teams,
                    "overs": round(total_overs, 1),
                    "wickets": wickets
                })
                
        except Exception as e:
            print(f"Error processing {fp.name}: {e}")

    return unfinished

if __name__ == "__main__":
    results = find_unfinished_innings()
    print(f"Found {len(results)} potential unfinished/abandoned first innings:")
    for r in results:
        print(f"{r['date']} | {r['match_file']} | {r['teams']} | {r['overs']} overs | {r['wickets']} wkts")
