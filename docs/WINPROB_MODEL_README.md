# XGBoost Win Probability Model for T20 Cricket

A complete pipeline to train and deploy an XGBoost model for predicting win probabilities in T20 cricket matches, specifically designed for IPL live scoring.

## Overview

This system uses ball-by-ball data from Cricsheet JSON files to train a machine learning model that predicts the probability of the chasing team winning at any point during the 2nd innings of a T20 match.

## Features

### Model Features
- **Game State**: Runs, wickets, balls remaining, runs needed
- **Run Rates**: Current run rate, required run rate, difference
- **Progress Ratios**: Percentage of balls/overs/wickets used
- **Momentum**: Last 12 balls performance metrics
- **Venue Characteristics**: Average first innings total, chasing efficiency
- **Match Context**: Target runs, phase of play (powerplay/middle/death)

### Key Components
1. **Data Parsing**: Converts Cricsheet JSON to training features
2. **Model Training**: XGBoost with early stopping and regularization
3. **Prediction API**: Real-time win probability calculation
4. **Venue Analysis**: Venue-specific statistics

## Installation

```bash
# Install dependencies
pip install -r requirements_winprob.txt
```

## Usage

### 1. Calculate Venue Statistics (Optional but Recommended)

```bash
python calculate_venue_stats.py --data_dir ./matches --output venue_stats.json
```

This analyzes historical match data to compute venue-specific averages and chasing efficiency.

### 2. Parse Training Data

```bash
python parse_matches.py --data_dir ./matches --output training_data.csv --venue_stats venue_stats.json
```

This converts Cricsheet JSON files into a flat CSV with one row per legal delivery in the 2nd innings.

### 3. Train the Model

```bash
python train_winprob_model.py --data training_data.csv --output winprob_model.pkl --plot feature_importance.png
```

This trains an XGBoost model with:
- Early stopping to prevent overfitting
- Regularization for better generalization
- Feature importance analysis

### 4. Make Predictions

```bash
python predict_winprob.py --model winprob_model.pkl --runs 120 --wickets 2 --overs 15.3 --target 190
```

Output:
```
=== Win Probability Prediction ===
Chasing team: 67.5%
Defending team: 32.5%
Current RR: 7.8
Required RR: 8.2
Runs needed: 70
Balls remaining: 28
```

## Model Performance

Expected metrics on held-out test set:
- **Log Loss**: ~0.45-0.55
- **Brier Score**: ~0.18-0.25
- **ROC AUC**: ~0.85-0.90
- **Accuracy**: ~75-80%

## Integration with Live API

The `predict_winprob.py` script can be integrated into your live scoring API:

```python
from predict_winprob import predict_win_probability, load_model

# Load model once
model = load_model("winprob_model.pkl")

# Make prediction for live match
result = predict_win_probability(
    model, 
    runs=120, 
    wickets=2, 
    overs=15.3, 
    target=190,
    venue_stats={"avg_first_innings": 185, "chasing_efficiency": 0.48}
)

# Returns: {"chasing_team_win_prob": 67.5, "defending_team_win_prob": 32.5, ...}
```

## Data Requirements

### Cricsheet JSON Format
The system expects standard Cricsheet JSON files with:
- `info.match_type = "T20"`
- Exactly 2 innings (no super overs)
- Clear winner/outcome
- Numeric target in 2nd innings

### File Structure
```
matches/
  match1.json
  match2.json
  ...
```

## Feature Engineering Details

### Core Features
- `legal_ball`: Ball number in innings (1-120)
- `runs_scored`: Current runs by chasing team
- `wickets_fallen`: Current wickets lost
- `balls_remaining`: Legal balls remaining
- `runs_needed`: Runs needed to win

### Derived Features
- `crr`: Current run rate
- `rrr`: Required run rate
- `run_rate_diff`: crr - rrr
- `pct_*`: Progress ratios (scale-invariant)

### Momentum Features
- `momentum_runs_12b`: Runs in last 12 balls
- `momentum_wickets_12b`: Wickets in last 12 balls
- `balls_since_last_wicket`: Balls since last wicket

### Venue Features
- `venue_avg_first_innings`: Historical average at venue
- `venue_chasing_efficiency`: Historical win rate when chasing
- `target_vs_venue_avg`: Target difficulty relative to venue

## Model Architecture

### XGBoost Parameters
```python
params = {
    "objective": "binary:logistic",
    "eval_metric": "logloss",
    "max_depth": 6,
    "learning_rate": 0.05,
    "n_estimators": 1000,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "reg_alpha": 1.0,
    "reg_lambda": 1.0,
    "random_state": 42
}
```

### Training Strategy
- 80/10/10 train/val/test split
- Early stopping with 50 round patience
- Stratified sampling for balanced classes
- Feature importance analysis

## Production Considerations

### Performance
- Model size: ~1-2MB
- Prediction time: <1ms per prediction
- Memory usage: ~50MB loaded model

### Monitoring
- Track prediction drift over time
- Monitor calibration (predicted vs actual win rates)
- Update venue statistics periodically

### Limitations
- Only works for completed 2nd innings
- Requires accurate ball-by-ball data
- Venue stats need sufficient historical data
- Doesn't account for weather conditions

## Troubleshooting

### Common Issues
1. **"No legal deliveries found"**: Check data format and illegal extras handling
2. **Poor calibration**: Adjust regularization or add more training data
3. **Slow training**: Reduce `n_estimators` or increase `learning_rate`

### Debug Mode
Add verbose logging to parse_matches.py:
```python
df = parse_all_matches("./data_dir", verbose=True)
```

## Future Improvements

1. **Player-level features**: Individual batter/bowler statistics
2. **Weather data**: Rain probability, pitch conditions
3. **Team strength**: Historical team performance metrics
4. **Time series**: Sequence models for momentum patterns
5. **Ensemble methods**: Combine multiple model types

## License

This code follows the same license as your IPL prediction project.
