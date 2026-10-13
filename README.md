# Cricket Score Prediction & Win Probability Models (IPL & ODI)

A live cricket analytics dashboard featuring two independent formats (IPL 20-Over and ODI 50-Over), each powered by:
1. **Resource Model** — predicts final innings scores from mid-innings snapshots with phase-aware run-rate shrinkage
2. **Monte Carlo Win Probability Simulator** — computes ball-by-ball chase win probabilities using empirical historical transition tables

Deployed at: **[ipl-score-prediction-model.vercel.app](https://ipl-score-prediction-model.vercel.app)**  
ODI Dashboard: **[ipl-score-prediction-model.vercel.app/odi.html](https://ipl-score-prediction-model.vercel.app/odi.html)**

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

## ODI Models (50-Over)

### 1. ODI Resource Model (Score Predictor)

**File:** `data/odi_model_params.json`  
**Used by:** `api/odi-recent.js`, the "Load into predictor" button in `odi.html`

The current first-innings evaluation uses 1,017 checkpoints across 274 filtered men's ODI matches from 2023 onwards: **MAE 20.43 runs** and **RMSE 27.17 runs**. It fits a 50-over Duckworth-Lewis inspired exponential resource curve with piecewise parameters and run-rate shrinkage:
- **Phases:** Overs 1–10, 11–20, 21–30, 31–40, and 41–50
- **Phase blend:** Smooth transition near each 10-over boundary

**Formula:**
```
predicted_final = current_score + RR_eff × C_k × (1 - exp(-b_k × overs_remaining)) × exp(-a_k × wickets_lost^gamma)

RR_eff = α_k × (current_score / overs_completed) + (1 - α_k) × μ_k
```

**Training script:** `scripts/update_odi_daily.py --skip-download`

---

### 2. ODI Monte Carlo Win Probability Simulator

**File:** `data/odi_winprob_sim_model.json`  
**Used by:** client-side JS in `odi.html` (runs directly in browser)

Empirical ball-by-ball transition table trained on 454 men's ODIs from 2023+ (223 unique states, 300 balls per innings).

**State space (223 states):**
```
phase (pp/mid/death) × wickets (0–10) × RRR bucket × balls_remaining bucket
────────────────────────────────────────────────────────────────────────────
pp (1–10), mid (11–40), death (41–50)
RRR: lt4 / 4_5 / 5_6 / 6_7 / ge7
Balls remaining: 1_60 / 61_120 / 121_180 / 181_240 / 241_300
```

**Global outcome probabilities** (fallback):
| W | 0 | 1 | 2 | 3 | 4 | 6 |
|---|---|---|---|---|---|---|
| 2.9% | 51.4% | 30.4% | 4.7% | 0.5% | 8.1% | 1.9% |

**Training script:** `scripts/train_odi_winprob_simulator.py`

---

## API Endpoints

### IPL Endpoints
- `GET /api/live` — Scrapes Cricbuzz for current IPL matches (live, upcoming, completed)
- `GET /api/scorecard?matchId=&slug=` — Fetches & persists ball-by-ball IPL data to Redis (`scorecard_{matchId}`)
- `GET /api/sync` — Cron-triggered sync endpoint for IPL
- `GET /api/recent?days=` — Historical IPL match predictions and MAE summary
- `GET /api/winprob` — Legacy server-side Monte Carlo simulator

### ODI Endpoints
- `GET /api/odi-live` — Scrapes Cricbuzz for live/recent men's ODI matches
- `GET /api/odi-scorecard?matchId=&slug=` — Fetches & persists ball-by-ball ODI data to Redis (`odi_scorecard_{matchId}`)
- `GET /api/odi-sync` — Cron-triggered sync endpoint for ODI matches
- `GET /api/odi-recent?days=` — Historical ODI predictions (2023+) and MAE/RMSE statistics
- `GET /api/odi-upcoming` — Upcoming ODI fixtures (local service)

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
│   ├── live.js                   # IPL match scraper (Cricbuzz)
│   ├── scorecard.js              # IPL ball-by-ball OBO API + Redis persistence
│   ├── sync.js                   # IPL cron-triggered sync endpoint
│   ├── recent.js                 # IPL recent match predictions
│   ├── odi-live.js               # ODI match scraper (Cricbuzz)
│   ├── odi-scorecard.js          # ODI ball-by-ball OBO API + Redis persistence
│   ├── odi-sync.js               # ODI cron-triggered sync endpoint
│   ├── odi-recent.js             # ODI recent match predictions
│   └── winprob.js                # Server-side Monte Carlo (legacy)
│
├── data/
│   ├── model_params.json         # IPL resource model fitted parameters
│   ├── winprob_sim_model.json    # IPL Monte Carlo transition table (178 states)
│   ├── odi_model_params.json     # ODI resource model fitted parameters
│   ├── odi_winprob_sim_model.json# ODI Monte Carlo transition table (223 states)
│   ├── venue_stats.json          # Venue average totals
│   ├── ipl_innings_snapshots.csv # IPL historical snapshots (2023+)
│   ├── odi_innings_snapshots.csv # Filtered ODI first-innings snapshots
│   ├── winprob_training_data.csv # Win probability training set
│   └── winprob_test_data.csv     # Win probability test set
│
├── scripts/
│   ├── app.py                    # Local Flask server for IPL dashboard (port 5050)
│   ├── app_odi.py                # Local Flask server for ODI dashboard (port 5051)
│   ├── ipl_service.py            # Service layer for IPL resource model
│   ├── odi_service.py            # Service layer for ODI resource model
│   ├── train_winprob_simulator.py# Trains IPL winprob_sim_model.json from ipl_male_json/
│   ├── train_odi_winprob_simulator.py # Trains ODI winprob_sim_model.json from odis_json/
│   ├── update_ipl_daily.py       # Daily IPL data refresh utility
│   ├── update_odi_daily.py       # Daily ODI data refresh & parameter fitting utility
│   ├── process_odi_data.py       # Extracts ODI snapshots from odis_json/
│   ├── parse_matches.py          # Parses IPL Cricsheet JSON → snapshots CSV
│   └── fit_rr_shrinkage.py       # Fits IPL resource model parameters
│
├── ipl_male_json/                # Cricsheet ball-by-ball IPL matches (2008–2026)
├── odis_json/                    # Cricsheet ball-by-ball ODI matches (3,200+ matches)
├── index.html                    # IPL Dashboard frontend (T20 format)
├── odi.html                      # ODI Dashboard frontend (50-over format)
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

## Retraining the ODI Models

### 1. ODI Resource Model & Innings Snapshots
```bash
# Downloads latest ODI matches from Cricsheet, generates odi_innings_snapshots.csv,
# and refits RR shrinkage + resource model parameters:
python scripts/update_odi_daily.py

# Or use existing local odis_json/ files without downloading:
python scripts/update_odi_daily.py --skip-download

# Output: odi_innings_snapshots.csv and data/odi_model_params.json
```

### 2. ODI Monte Carlo Win Probability Simulator
```bash
# Trains 50-over transition table across 223 game states (2023+ men's ODIs):
python scripts/train_odi_winprob_simulator.py

# Output: data/odi_winprob_sim_model.json
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
