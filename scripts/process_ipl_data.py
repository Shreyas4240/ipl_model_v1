import pandas as pd
import json
import os
from datetime import datetime

def extract_innings_snapshots_from_ipl():
    """
    Extract innings snapshots from IPL JSON files into ipl_innings_snapshots.csv
    """
    snapshots = []
    ipl_dir = "ipl_male_json"
    
    # Get all JSON files
    json_files = [f for f in os.listdir(ipl_dir) if f.endswith('.json')]
    print(f"Found {len(json_files)} IPL JSON files")

    # Blacklisted abandoned/rain matches (unfinished first innings)
    BLACKLIST = {
        "336022.json", "1426298.json", "501215.json", "1473471.json", "501255.json",
        "733971.json", "1136566.json", "336012.json", "829807.json", "1473495.json",
        "1136592.json", "501265.json", "1527685.json", "1178424.json", "336010.json",
        "1359519.json", "980989.json", "1527686.json", "392183.json", "980999.json",
        "829803.json", "598068.json", "548307.json", "829771.json", "392214.json"
    }
    
    for json_file in json_files:
        if json_file in BLACKLIST:
            print(f"Skipping blacklisted match: {json_file}")
            continue
        try:
            with open(os.path.join(ipl_dir, json_file), 'r') as f:
                match_data = json.load(f)
            
            info = match_data.get('info', {})
            date_str = info.get('dates', ['Unknown'])[0]
            
            if date_str != 'Unknown':
                try:
                    match_date = datetime.strptime(date_str, '%Y-%m-%d')
                    if match_date.year < 2023:
                        continue
                except ValueError:
                    continue
            
            match_id = json_file.replace('.json', '')
            teams = info.get('teams', [])
            
            # Process each innings
            for innings in match_data.get('innings', []):
                team = innings.get('team', '')
                overs_data = innings.get('overs', [])
                
                # Calculate final total for this innings
                final_total = 0
                for over in overs_data:
                    for delivery in over.get('deliveries', []):
                        final_total += delivery.get('runs', {}).get('total', 0)
                
                # Create snapshots for each ball
                balls_bowled = 0
                current_score = 0
                wickets = 0
                
                for over in overs_data:
                    over_num = over.get('over', 0)
                    
                    for delivery in over.get('deliveries', []):
                        balls_bowled += 1
                        current_score += delivery.get('runs', {}).get('total', 0)
                        
                        # Count wickets
                        if 'wickets' in delivery:
                            wickets += len(delivery['wickets'])
                        
                        # Calculate overs completed
                        overs_completed = balls_bowled / 6.0
                        overs_remaining = 20 - overs_completed
                        
                        # Calculate run rate (runs per over)
                        if overs_completed > 0:
                            run_rate = current_score / overs_completed
                        else:
                            run_rate = 0
                        
                        # Only add snapshots for meaningful overs (every 0.5 overs or when wickets fall)
                        if balls_bowled % 3 == 0 or 'wickets' in delivery:  # Every 3 balls (0.5 overs)
                            snapshots.append({
                                'team': team,
                                'balls_bowled': balls_bowled,
                                'overs_completed': overs_completed,
                                'overs_remaining': overs_remaining,
                                'wickets': wickets,
                                'run_rate': run_rate,
                                'current_score': current_score,
                                'final_total': final_total,
                                'match_file': json_file
                            })
                
                # Add final snapshot
                if balls_bowled > 0:
                    snapshots.append({
                        'team': team,
                        'balls_bowled': balls_bowled,
                        'overs_completed': balls_bowled / 6.0,
                        'overs_remaining': max(0, 20 - balls_bowled / 6.0),
                        'wickets': wickets,
                        'run_rate': current_score / (balls_bowled / 6.0) if balls_bowled > 0 else 0,
                        'current_score': current_score,
                        'final_total': final_total,
                        'match_file': json_file
                    })
                    
        except Exception as e:
            print(f"Error processing {json_file}: {e}")
    
    # Create DataFrame
    df = pd.DataFrame(snapshots)
    
    # Filter for matches since 2020
    df_filtered = df.copy()
    
    print(f"Created {len(df)} snapshots from {len(df['match_file'].unique())} matches")
    print(f"Date range: {df_filtered['match_file'].nunique()} unique matches")
    
    # Save to CSV
    df_filtered.to_csv('ipl_innings_snapshots.csv', index=False)
    print("Saved IPL innings snapshots to ipl_innings_snapshots.csv")
    
    return df_filtered

if __name__ == "__main__":
    df = extract_innings_snapshots_from_ipl() 