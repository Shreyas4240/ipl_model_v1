"""
Flask app for IPL resource model test results: recent matches (predicted vs actual)
and upcoming fixtures. Routes mirror Vercel: GET /api/recent, GET /api/upcoming.
"""
import os
import urllib.parse
import urllib.request
from flask import Flask, jsonify, send_from_directory

from ipl_service import get_recent_results, get_upcoming_fixtures
from odi_service import get_recent_results as get_odi_recent_results
from odi_service import get_upcoming_fixtures as get_odi_upcoming_fixtures

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path="")

# Run from project root so the IPL data files resolve in both local routes.

@app.route("/")
@app.route("/index.html")
def index():
    return send_from_directory(PROJECT_ROOT, "index.html")


@app.route("/odi.html")
def odi_index():
    return send_from_directory(PROJECT_ROOT, "odi.html")

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


@app.route("/api/odi-recent")
def api_odi_recent():
    from flask import request
    try:
        days = request.args.get("days", 30, type=int)
        days = max(1, min(9999, days))
        data = get_odi_recent_results(past_days=days)
        data["summary"]["days_requested"] = days
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e), "results": [], "summary": {"count": 0, "mae": 0}}), 500


@app.route("/api/odi-upcoming")
def api_odi_upcoming():
    try:
        return jsonify({"fixtures": get_odi_upcoming_fixtures()})
    except Exception as e:
        return jsonify({"error": str(e), "fixtures": []}), 500


@app.route("/api/odi-live")
def api_odi_live():
    """Return every men's ODI listed on Cricbuzz; no team whitelist is applied."""
    try:
        import re
        from datetime import datetime, timezone
        import requests
        from bs4 import BeautifulSoup

        response = requests.get(
            "https://www.cricbuzz.com/cricket-match/live-scores",
            headers={"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"},
            timeout=15,
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        matches, seen = [], set()
        for link in soup.select('a[href*="/live-cricket-scores/"]'):
            href = link.get("href", "")
            text = link.get_text(" ", strip=True)
            lower = href.lower()
            match_id = re.search(r"/live-cricket-scores/(\d+)/", href)
            if not match_id or match_id.group(1) in seen:
                continue
            normal_start = response.text.find(f'"matchId":{match_id.group(1)}')
            escaped_start = response.text.find(f'\\"matchId\\":{match_id.group(1)}')
            is_odi_payload = (
                normal_start >= 0 and '"matchFormat":"ODI"' in response.text[normal_start:normal_start + 2500]
            ) or (
                escaped_start >= 0 and '\\"matchFormat\\":\\"ODI\\"' in response.text[escaped_start:escaped_start + 2500]
            )
            if (not is_odi_payload and "odi" not in lower) or "women" in lower or "t20" in lower:
                continue
            teams = re.search(r"([A-Z]{2,5})\s+vs\s+([A-Z]{2,5})", text)
            if not teams:
                continue
            is_complete = bool(re.search(r"won by|completed|final|abandoned|no result", text, re.I))
            is_live = not is_complete and bool(re.search(r"opt to bat|opt to bowl|toss|live|batting|bowling|running|need|runs|crr|rrr|innings break|rain|delay|\d+/\d+", text, re.I))
            score = re.search(r"(\d{1,3})/(\d{1,2})\s*\((\d{1,2}(?:\.\d)?)\)", text)
            innings = None
            if score:
                innings = {"team": teams.group(1), "runs": int(score.group(1)), "wickets": int(score.group(2)), "overs": score.group(3)}
            matches.append({
                "matchId": match_id.group(1),
                "slug": href.split("/live-cricket-scores/")[1].split("/", 1)[1] if "/" in href.split("/live-cricket-scores/")[1] else "",
                "teams": [teams.group(1), teams.group(2)],
                "status": "completed" if is_complete else "live" if is_live else "upcoming",
                "series": "ODI",
                "result": "Match completed" if is_complete else "In progress" if is_live else "Upcoming",
                "scraped_at": datetime.now(timezone.utc).isoformat(),
                "innings1": innings,
                "innings2": None,
                "score": {"runs": innings["runs"] if innings else None, "wickets": innings["wickets"] if innings else None, "overs_input": innings["overs"] if innings else None},
                "href": href,
            })
            seen.add(match_id.group(1))
        return jsonify({"matches": matches[:12]})
    except Exception as e:
        return jsonify({"error": str(e), "matches": []}), 500

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
