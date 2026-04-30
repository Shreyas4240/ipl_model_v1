# IPL Score Prediction & Win Probability Model

A live IPL match dashboard with two independent predictive models:
1. **Resource Model** — predicts final innings scores from mid-innings snapshots
2. **Monte Carlo Win Probability Simulator** — computes ball-by-ball chase win probability using historical transition tables

Deployed at: **[ipl-score-prediction-model.vercel.app](https://ipl-score-prediction-model.vercel.app)**

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (index.html)                │
│  • Live match cards (auto-refresh every 60s)            │
│  • Score predictor (resource model via /api/recent)     │
│  • Win probability chart (client-side Monte Carlo)      │
└──────────────┬──────────────────────────────────────────┘
               │ fetch
     ┌─────────┴──────────┐
     │   Vercel Serverless │
     │   API Functions     │
     └─────────┬──────────┘
               │
    ┌──────────┼──────────────┐
    │          │              │
 /api/live  /api/scorecard  /api/sync
    │          │              │
    └──────────┴──────┬───────┘
                      │ scrapes
              Cricbuzz OBO API
              /api/mcenter/over-by-over/{matchId}/{inningsId}
                      │
                      ▼
              Upstash Redis
              scorecard_{matchId}   ← ball-by-ball data
              scorecard_meta_{matchId}
```

---

## Models

### 1. Resource Model (Score Predictor)

**File:** `data/model_params.json`  
**Used by:** `api/recent.js`, the "Load into predictor" button in the UI

Fits a Duckworth-Lewis-style resource curve to predict what a team will finish on given their current score, wickets, and overs. Parameters are fitted via non-linear least squares on IPL matches from 2023 onwards.

**Formula:**
```
predicted_final = current_runs / (1 - resource_remaining)

resource_remaining = f(wickets_lost, overs_remaining, phase)
```

Three phases (Powerplay 1–6, Middle 7–16, Death 17–20), each with fitted `z` (decay), `b` (wicket penalty), and `L` (resource ceiling) parameters. A gamma correction term handles wicket clusters.

**Training data:** `data/model_params.json` (generated `2026-04-17`, trained on matches from `2023-01-01`)  
**Training script:** `scripts/fit_rr_shrinkage.py`

---

### 2. Monte Carlo Win Probability Simulator

**File:** `data/winprob_sim_model.json`  
**Used by:** client-side JS in `index.html` (runs entirely in the browser)

A ball-by-ball transition table trained on 214 IPL matches (2023–2025). At each game state, it stores the empirical probability of each outcome (`W`, `0`, `1`, `2`, `3`, `4`, `6`).

**State space (178 states):**
```
phase       × wickets × required_run_rate × balls_remaining
──────────────────────────────────────────────────────────
pp/mid/death  0–10      lt6/6_8/8_10/       1_30/31_60/
                        10_12/ge12           61_90/91_120
```

**At query time:**
- Runs 2,500 Monte Carlo simulations from current state forward
- Returns `chasing_win_prob` ∈ [0, 1]
- Falls back to `global_probs` for states with <15 historical observations

**Key design choice:** The simulation runs **client-side in the browser** (not server-side) — the 48KB model JSON is fetched once and cached. This eliminates ~113 sequential API calls per innings, dropping chart render time from ~60s to ~200ms.

**Training script:** `scripts/train_winprob_simulator.py`

**Global outcome probabilities** (fallback):
| W | 0 | 1 | 2 | 3 | 4 | 6 |
|---|---|---|---|---|---|---|
| 5.4% | 28.7% | 39.0% | 6.0% | 0.2% | 13.6% | 7.2% |

---

## API Endpoints

### `GET /api/live`
Scrapes Cricbuzz for current IPL match data. Returns up to 3 matches (live, upcoming, recently completed).

**Response:**
```json
{
  "matches": [
    {
      "matchId": "151954",
      "slug": "mi-vs-srh-41st-match-indian-premier-league-2026",
      "teams": ["Mumbai Indians", "Sunrisers Hyderabad"],
      "status": "completed",
      "series": "Indian Premier League 2026",
      "venue": "Wankhede Stadium",
      "result": "Sunrisers Hyderabad won by 6 wickets",
      "innings1": { "team": "Mumbai Indians", "runs": 243, "wickets": 5, "overs": "19.6" },
      "innings2": { "team": "Sunrisers Hyderabad", "runs": 249, "wickets": 4, "overs": "18.4" }
    }
  ]
}
```

**Vercel config:** 512MB, 10s max duration

---

### `GET /api/scorecard?matchId=&slug=`
Fetches and persists ball-by-ball data to Redis. Called by the frontend when rendering the win probability chart.

**Data pipeline:**
1. **Primary:** `GET https://www.cricbuzz.com/api/mcenter/over-by-over/{matchId}/{inningsId}` — paginated JSON API. Fetches all overs for both innings simultaneously. Expands `ovrSummary` strings (e.g. `"4 6 0 W 1"`) into per-ball cumulative scores.
2. **Fallback:** Full-commentary HTML parse (Cricbuzz embeds a `matchPreviewFullComm` JSON block)
3. **Live point:** Appends current live score from `/api/live` as the latest data point
4. **Merge:** New balls merged with Redis-stored history (deduped by `innings-overLabel` key)
5. **Monotone filter:** Non-monotonic points (stale Redis snapshots) are silently dropped

Yields ~120 per-ball data points per innings for a completed match (vs. 9 coarse end-of-over snapshots with the old approach).

**Redis keys:**
- `scorecard_{matchId}` — ball array (TTL: 24h)
- `scorecard_meta_{matchId}` — metadata (source, updatedAt)

**Vercel config:** 1024MB, 30s max duration

---

### `GET /api/sync`
Triggered by an external cron job. Internally calls `/api/live` to find all live/completed matches, then runs `fetchAndMergeScorecard` for each.

**Use case:** Ensures Redis stays updated throughout the match without a user needing the page open.

**Vercel config:** 1024MB, 60s max duration

---

### `GET /api/recent`
Returns recent completed matches with actual vs. model-predicted scores. Used by the "Recent Predictions" section of the dashboard.

**Vercel config:** 1024MB, 30s max duration

---

### `GET /api/winprob` *(legacy — no longer called by frontend)*
Server-side Monte Carlo endpoint. Still available but the frontend now runs the simulation client-side. Accepts `?runs=&wickets=&overs=&target=&sims=`.

---

## Data Pipeline (Live Match Day)

```
T-0: Match starts
  └─ External cron → GET /api/sync (every ~2 min)
       └─ fetchAndMergeScorecard(matchId, slug)
            └─ GET cricbuzz.com/api/mcenter/over-by-over/{id}/1  (innings 1)
            └─ GET cricbuzz.com/api/mcenter/over-by-over/{id}/2  (innings 2)
            └─ expand ovrSummary → per-ball cumulative scores
            └─ merge with Redis → store

T+user: User opens page
  └─ GET /api/live → renders match card
  └─ GET /api/scorecard → returns all balls from Redis
  └─ fetch /data/winprob_sim_model.json (once, cached)
  └─ for each innings-2 ball: run 2500 Monte Carlo sims in browser
  └─ chart renders (0–20 overs x-axis, chasing win% y-axis)
```

During innings 1: `canChart = false` (no chase data yet). Chart appears once innings 1 is complete and innings 2 begins.

---

## Project Structure

```
extended_essay_model/
├── api/                          # Vercel serverless functions
│   ├── live.js                   # Cricbuzz match scraper
│   ├── scorecard.js              # Ball-by-ball OBO API + Redis persistence
│   ├── sync.js                   # Cron-triggered sync endpoint
│   ├── recent.js                 # Recent match predictions
│   └── winprob.js                # Server-side Monte Carlo (legacy)
│
├── data/
│   ├── model_params.json         # Resource model fitted parameters
│   ├── winprob_sim_model.json    # Monte Carlo transition table (178 states)
│   ├── venue_stats.json          # Venue average totals
│   ├── ipl_innings_snapshots.csv # Historical mid-innings snapshots (resource model training)
│   ├── winprob_training_data.csv # Win probability training set
│   └── winprob_test_data.csv     # Win probability test set
│
├── scripts/
│   ├── train_winprob_simulator.py  # Trains winprob_sim_model.json from ipl_male_json/
│   ├── parse_matches.py            # Parses Cricsheet JSON → snapshots CSV
│   ├── parse_matches_by_year.py    # Year-filtered parse
│   ├── calculate_venue_stats.py    # Computes venue averages
│   ├── fit_rr_shrinkage.py         # Fits resource model parameters
│   ├── train_calibrated_model.py   # Trains/evaluates calibrated sklearn model
│   ├── predict_enhanced_winprob.py # Prediction utilities
│   ├── score_projection.py         # Score projection utilities
│   ├── plot_simulator_curve_latest.py # Plot win prob curves for latest match
│   └── update_ipl_daily.py         # Daily data refresh utility
│
├── ipl_male_json/                # Cricsheet ball-by-ball match JSON files
│   └── *.json                    # One file per match (2008–2026)
│
├── models/
│   └── winprob_model_selection.json  # Model selection metadata
│
├── docs/
│   └── WINPROB_MODEL_README.md   # Extended win probability model documentation
│
├── index.html                    # Single-page frontend (vanilla JS + Chart.js)
├── package.json                  # Node.js dependencies (axios, cheerio)
├── vercel.json                   # Serverless function config
├── requirements.txt              # Python dependencies
└── .env                          # Local secrets (never committed)
```

---

## Setup

### Environment Variables

Create a `.env` file (see `.gitignore` — never committed):

```env
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=your_token_here
KV_REST_API_READ_ONLY_TOKEN=your_readonly_token_here
```

These are Upstash Redis REST API credentials. Get them from [console.upstash.com](https://console.upstash.com).

### Node.js (API functions)

```bash
npm install
```

Dependencies: `axios` (HTTP), `cheerio` (HTML parsing for live scraper).

### Python (model training)

```bash
pip install -r requirements.txt
```

### Local Development

Vercel's dev server emulates the serverless environment:

```bash
vercel dev
```

### Deploy

```bash
vercel --prod
```

---

## Retraining the Win Probability Simulator

The Monte Carlo model is trained from Cricsheet ball-by-ball JSON files in `ipl_male_json/`.

```bash
# 1. Add new match JSON files to ipl_male_json/
#    Download from: https://cricsheet.org/matches/

# 2. Retrain
python scripts/train_winprob_simulator.py

# Output: data/winprob_sim_model.json
# This file is served as a static asset at /data/winprob_sim_model.json
```

The training script:
- Iterates all JSON files, filters to T20 IPL matches
- For each ball, computes game state → (phase, wickets, RRR bucket, balls-remaining bucket)
- Accumulates outcome counts per state
- Normalises into probability distributions
- Falls back to global distribution for states with n < 15

---

## Retraining the Resource Model

```bash
# 1. Parse Cricsheet data into innings snapshots
python scripts/parse_matches.py

# 2. Fit the resource model
python scripts/fit_rr_shrinkage.py

# Output: data/model_params.json
```

---

## External Cron Setup

The `/api/sync` endpoint must be called regularly during live matches to keep Redis updated. Set up an external cron service (e.g. [cron-job.org](https://cron-job.org), EasyCron) to:

```
GET https://ipl-score-prediction-model.vercel.app/api/sync
Frequency: every 2 minutes
```

This works independently of any user having the page open.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Client-side Monte Carlo | Eliminates 113 sequential serverless calls per innings (60s → 200ms render) |
| OBO paginated API over HTML parsing | Cricbuzz's `matchPreviewFullComm` only contains pre-match commentary; OBO API gives all overs for both innings |
| Soft monotone filter (drop not throw) | Stale Redis snapshots from previous sync can collide with fresh OBO data; soft drop keeps the rest |
| Redis merge by `innings-overLabel` key | Prevents duplicate entries while allowing the most recent timestamp to win |
| 24h Redis TTL | Keeps storage minimal; completed matches are still readable same day |
| Separate `scorecard_meta_{matchId}` key | Allows source attribution and mismatch detection without deserialising the full ball array |
