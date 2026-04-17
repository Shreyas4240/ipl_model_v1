"""
Flask app for IPL resource model test results: recent matches (predicted vs actual)
and upcoming fixtures. Routes mirror Vercel: GET /api/recent, GET /api/upcoming.
"""
import os
import urllib.parse
import urllib.request
from flask import Flask, jsonify, send_from_directory

from ipl_service import get_recent_results, get_upcoming_fixtures

app = Flask(__name__, static_folder="static", static_url_path="")

# Run from project root so ipl_innings_snapshots.csv and ipl_male_json resolve
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

@app.route("/")
def index():
    return send_from_directory(PROJECT_ROOT, "index.html")

@app.route("/api/recent")
def api_recent():
    from flask import request
    try:
        days = request.args.get("days", 30, type=int)
        days = max(1, min(9999, days))  # 1–9999 (9999 = all time)
    except (TypeError, ValueError):
        days = 30
    try:
        data = get_recent_results(past_days=days)
        data["summary"]["days_requested"] = days
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e), "results": [], "summary": {"count": 0, "mae": 0}}), 500

@app.route("/api/live")
def api_live():
    """Scrape live IPL matches from Cricbuzz using the current page structure."""
    try:
        import requests
        from bs4 import BeautifulSoup
        import re
        from datetime import datetime
        
        BASE_URL = "https://www.cricbuzz.com"
        LIVE_URL = f"{BASE_URL}/cricket-match/live-scores"
        
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Referer": BASE_URL,
        }
        
        # Fetch the page
        response = requests.get(LIVE_URL, headers=headers, timeout=15)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, "lxml")
        matches = []
        now = datetime.utcnow().isoformat() + "Z"
        
        # Look for the specific match container we identified
        match_container = soup.find('div', class_='bg-[#444]')
        if not match_container:
            return jsonify({"matches": []})
        
        container_text = match_container.get_text()
        
        # Find IPL section in the container
        ipl_section_match = re.search(r'IPL\s*2026(.+?)(?:Pakistan|$)', container_text, re.IGNORECASE | re.DOTALL)
        if not ipl_section_match:
            return jsonify({"matches": []})
        
        ipl_section = ipl_section_match.group(1)
        
        # Extract individual matches using regex
        # Pattern: Team1 vs Team2 MatchNumber
        match_pattern = re.compile(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+vs\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(\d+(?:st|nd|rd|th)\s+Match)', re.IGNORECASE)
        
        found_matches = match_pattern.findall(ipl_section)
        
        unique_matches = {}
        for team1, team2, match_info in found_matches:
            team1 = team1.strip()
            team2 = team2.strip()
            
            team_mapping = {
                'Super Giants': 'Lucknow Super Giants',
                'Royal Challengers Bengaluru': 'Royal Challengers Bengaluru',
                'Indians': 'Mumbai Indians',
                'Punjab Kings': 'Punjab Kings',
                'Chennai Super Kings': 'Chennai Super Kings',
                'Kolkata Knight Riders': 'Kolkata Knight Riders',
                'Rajasthan Royals': 'Rajasthan Royals',
                'Delhi Capitals': 'Delhi Capitals',
                'Sunrisers Hyderabad': 'Sunrisers Hyderabad',
                'Gujarat Titans': 'Gujarat Titans'
            }
            
            full_team1 = team_mapping.get(team1, team1)
            full_team2 = team_mapping.get(team2, team2)
            
            key = match_info.strip()
            if key not in unique_matches:
                score_data = {
                    'runs': None,
                    'wickets': None,
                    'overs_decimal': None,
                    'overs_input': None
                }
                unique_matches[key] = {
                    'teams': [full_team1, full_team2],
                    'score': score_data,
                    'status': 'upcoming',
                    'series': 'IPL 2026',
                    'result': f'{match_info} - Scheduled',
                    'scraped_at': now
                }
        
        matches = list(unique_matches.values())
        
        # Remove old games, only keep live and upcoming (max 2 matches)
        matches = matches[:2]
        
        return jsonify({"matches": matches})
        
    except requests.RequestException as e:
        return jsonify({"error": f"Failed to fetch Cricbuzz: {str(e)}", "matches": []}), 500
    except Exception as e:
        return jsonify({"error": f"Scraping error: {str(e)}", "matches": []}), 500

@app.route("/api/upcoming")
def api_upcoming():
    try:
        fixtures = get_upcoming_fixtures()
        return jsonify({"fixtures": fixtures})
    except Exception as e:
        return jsonify({"error": str(e), "fixtures": []}), 500

if __name__ == "__main__":
    os.chdir(PROJECT_ROOT)
    # Use 5050 to avoid conflict with macOS AirPlay on 5000
    app.run(debug=True, port=5050)
