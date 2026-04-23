# IPL Score Prediction Model

## Project Structure

```
extended_essay_model/
|-- api/                    # Vercel serverless functions
|   |-- live.js            # Live match scraping
|   |-- winprob-enhanced.js # Enhanced win probability API
|   `-- winprob.js         # Basic win probability API
|-- models/                 # Trained ML models
|   `-- winprob_model_momentum.pkl # Momentum-enhanced model
|-- data/                   # Training and test data
|   |-- winprob_training_data.csv # Training data with momentum
|   |-- winprob_test_data.csv     # Test data with momentum
|   |-- ipl_innings_snapshots.csv  # Historical IPL data
|   `-- model_params.json         # Model parameters
|-- scripts/                # Data processing and training scripts
|   |-- add_simple_momentum.py    # Momentum feature extraction
|   |-- calculate_venue_stats.py   # Venue statistics
|   |-- parse_matches.py           # Data parsing
|   |-- train_calibrated_model.py  # Model training
|   `-- predict_enhanced_winprob.py # Prediction script
|-- docs/                   # Documentation
|   |-- WINPROB_MODEL_README.md    # Model documentation
|   `-- MOMENTUM_FEATURES.md        # Momentum features guide
|-- analysis/               # Analysis plots and results
|   |-- winprob_feature_importance.png
|   |-- momentum_calibration.png
|   `-- enhanced_calibration.png
|-- index.html             # Main web interface
|-- package.json           # Node.js dependencies
|-- requirements.txt       # Python dependencies
|-- venue_stats.json      # Venue statistics
`-- vercel.json           # Vercel configuration
```

## Key Features

- **Live Match Scoring**: Real-time IPL match data scraping
- **Win Probability Prediction**: ML-based predictions with momentum features
- **Momentum Analysis**: Recent ball-by-ball performance tracking
- **Venue-Specific Stats**: Location-based performance adjustments
- **Database System**: Server-side ball-by-ball data storage with Redis

## Database System

### Overview
The project includes a robust database system for storing live match data in Upstash Redis:

- **JSON Instance**: `match_history_v2_{matchId}` per match
- **Data Source**: Cricbuzz scraper with real-time updates
- **Format**: Ball-by-ball JSON with innings, over, runs, wickets
- **Isolation**: Each match has separate Redis key (no cross-contamination)
- **Server-Side**: Works 24/7 without user's computer

### API Endpoints
- `/api/live` - Live match data with team scores
- `/api/scorecard` - Ball-by-ball data storage and retrieval
- `/api/scorecard/clear` - Clear match data from Redis

### Setup Instructions

1. **Environment Variables** (add to `.env`):
   ```
   KV_REST_API_URL=your_upstash_redis_url
   KV_REST_API_TOKEN=your_upstash_redis_token
   REDIS_URL=your_redis_connection_string
   ```

2. **Dependencies**: `pip install -r requirements.txt`

3. **Local Development**: `python scripts/app.py`

4. **Production Deploy**: `vercel --prod`

5. **Security**: `.env` file is excluded from git (see `.gitignore`)

### Data Structure
```json
{
  "innings": 2,
  "ball": 1,
  "over": 1.5,
  "overLabel": "1.3",
  "runs": 45,
  "wickets": 1
}
```

## Quick Start

1. Install dependencies: `pip install -r requirements.txt`
2. Train model: `python scripts/train_calibrated_model.py`
3. Run locally: `python scripts/app.py`
4. Deploy: `vercel --prod`

## Model Performance

- **Accuracy**: 77.8% (momentum-enhanced)
- **ROC AUC**: 0.862
- **Features**: Game state, momentum, venue statistics
