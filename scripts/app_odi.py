"""
Flask app for the ODI resource model. Separate from app.py (IPL).
Serves odi.html and /api/odi-recent, /api/odi-upcoming.
"""
import os
import sys

from flask import Flask, jsonify, request, send_from_directory

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from odi_service import get_recent_results, get_upcoming_fixtures
from ipl_service import get_recent_results as get_ipl_recent_results

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = Flask(__name__, static_folder=PROJECT_ROOT, static_url_path="")


@app.route("/")
@app.route("/odi.html")
def index():
    return send_from_directory(PROJECT_ROOT, "odi.html")


@app.route("/index.html")
def ipl_dashboard():
    return send_from_directory(PROJECT_ROOT, "index.html")


@app.route("/api/odi-recent")
@app.route("/api/recent")
def api_recent():
    try:
        days = request.args.get("days", 30, type=int)
        days = max(1, min(9999, days))
    except (TypeError, ValueError):
        days = 30
    try:
        data = get_recent_results(past_days=days)
        data["summary"]["days_requested"] = days
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e), "results": [], "summary": {"count": 0, "mae": 0}}), 500


@app.route("/api/ipl-recent")
def api_ipl_recent():
    try:
        days = request.args.get("days", 30, type=int)
        days = max(1, min(9999, days))
        data = get_ipl_recent_results(past_days=days)
        data["summary"]["days_requested"] = days
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e), "results": [], "summary": {"count": 0, "mae": 0}}), 500


@app.route("/api/ipl-live")
def api_ipl_live():
    from app import api_live
    return api_live()


@app.route("/api/odi-upcoming")
def api_upcoming():
    try:
        fixtures = get_upcoming_fixtures()
        return jsonify({"fixtures": fixtures})
    except Exception as e:
        return jsonify({"error": str(e), "fixtures": []}), 500


if __name__ == "__main__":
    os.chdir(PROJECT_ROOT)
    app.run(debug=True, port=5051)
