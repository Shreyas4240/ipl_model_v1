"""
train_winprob_model.py
----------------------
Train an XGBoost win probability model using the parsed Cricsheet data.

Features include game state, run rates, momentum, venue characteristics,
and progress ratios. The model learns win probability for each legal delivery
in the 2nd innings.

Usage:
    python train_winprob_model.py --data training_data.csv --output model.pkl
"""

import pandas as pd
import numpy as np
import xgboost as xgb
import pickle
import argparse
from sklearn.model_selection import train_test_split
from sklearn.metrics import log_loss, brier_score_loss, roc_auc_score
import matplotlib.pyplot as plt
import seaborn as sns

# Feature columns for the model
FEATURE_COLS = [
    "legal_ball",
    "runs_scored", "wickets_fallen", "wickets_remaining", "balls_remaining", "runs_needed",
    "over", "crr", "rrr", "run_rate_diff",
    "pct_balls_used", "pct_runs_scored", "pct_wickets_fallen",
    "momentum_runs_12b", "momentum_wickets_12b", "momentum_run_rate_12b",
    "balls_since_last_wicket",
    "venue_avg_first_innings", "venue_chasing_efficiency", "target_vs_venue_avg",
    "projected_final_score", "projected_margin",
    "target_runs", "target_overs"
]

CATEGORICAL_COLS = ["phase"]


def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """
    Prepare features for XGBoost training.
    
    Returns:
        X: Feature DataFrame
        y: Target Series (chasing_team_won)
    """
    # Make a copy to avoid modifying original
    df = df.copy()
    
    # Handle categorical variables
    if df["phase"].dtype.name == 'category':
        df["phase"] = df["phase"].cat.codes  # Convert to numeric (0=powerplay, 1=middle, 2=death)
    else:
        # Convert to categorical then to numeric codes
        df["phase"] = pd.Categorical(df["phase"], categories=["powerplay", "middle", "death"], ordered=True).codes
    
    # Select features
    X = df[FEATURE_COLS + CATEGORICAL_COLS].copy()
    y = df["chasing_team_won"]
    
    # Basic feature validation
    print(f"Feature matrix shape: {X.shape}")
    print(f"Target distribution: {y.value_counts(normalize=True)}")
    
    return X, y


def train_model(X_train, y_train, X_val, y_val) -> xgb.XGBClassifier:
    """
    Train XGBoost model with early stopping.
    """
    # XGBoost parameters optimized for win probability
    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 6,
        "learning_rate": 0.05,
        "n_estimators": 300,  # Reduced since no early stopping
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 1.0,  # L1 regularization
        "reg_lambda": 1.0,  # L2 regularization
        "min_child_weight": 1,
        "random_state": 42,
        "n_jobs": -1
    }
    
    model = xgb.XGBClassifier(**params)
    
    # Simple training without early stopping
    model.fit(X_train, y_train)
    
    return model


def evaluate_model(model: xgb.XGBClassifier, X_test, y_test) -> dict:
    """
    Evaluate model performance with relevant metrics.
    """
    # Predict probabilities
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    y_pred = (y_pred_proba >= 0.5).astype(int)
    
    # Calculate metrics
    metrics = {
        "log_loss": log_loss(y_test, y_pred_proba),
        "brier_score": brier_score_loss(y_test, y_pred_proba),
        "roc_auc": roc_auc_score(y_test, y_pred_proba),
        "accuracy": np.mean(y_pred == y_test)
    }
    
    print("\n=== Model Performance ===")
    for metric, value in metrics.items():
        print(f"{metric}: {value:.4f}")
    
    return metrics


def plot_feature_importance(model: xgb.XGBClassifier, save_path: str = None):
    """
    Plot feature importance.
    """
    feature_names = FEATURE_COLS + CATEGORICAL_COLS
    importance = model.feature_importances_
    
    # Create DataFrame for plotting
    imp_df = pd.DataFrame({
        "feature": feature_names,
        "importance": importance
    }).sort_values("importance", ascending=False)
    
    # Plot
    plt.figure(figsize=(10, 8))
    sns.barplot(data=imp_df.head(15), x="importance", y="feature")
    plt.title("Top 15 Feature Importance - XGBoost Win Probability Model")
    plt.xlabel("Importance")
    plt.tight_layout()
    
    if save_path:
        plt.savefig(save_path, dpi=300, bbox_inches="tight")
        print(f"Feature importance plot saved to {save_path}")
    else:
        plt.show()


def save_model(model: xgb.XGBClassifier, filepath: str):
    """
    Save trained model to pickle file.
    """
    with open(filepath, "wb") as f:
        pickle.dump(model, f)
    print(f"Model saved to {filepath}")


def main():
    parser = argparse.ArgumentParser(description="Train XGBoost win probability model")
    parser.add_argument("--data", required=True, help="Training data CSV file")
    parser.add_argument("--output", default="winprob_model.pkl", help="Output model file")
    parser.add_argument("--plot", default="feature_importance.png", help="Feature importance plot")
    parser.add_argument("--test_size", type=float, default=0.2, help="Test set proportion")
    args = parser.parse_args()
    
    # Load data
    print(f"Loading data from {args.data}...")
    df = pd.read_csv(args.data)
    print(f"Data shape: {df.shape}")
    
    # Prepare features
    X, y = prepare_features(df)
    
    # Split data
    X_train, X_temp, y_train, y_temp = train_test_split(
        X, y, test_size=args.test_size, random_state=42, stratify=y
    )
    X_val, X_test, y_val, y_test = train_test_split(
        X_temp, y_temp, test_size=0.5, random_state=42, stratify=y_temp
    )
    
    print(f"Train: {X_train.shape}, Val: {X_val.shape}, Test: {X_test.shape}")
    
    # Train model
    print("\nTraining XGBoost model...")
    model = train_model(X_train, y_train, X_val, y_val)
    
    # Evaluate
    metrics = evaluate_model(model, X_test, y_test)
    
    # Plot feature importance
    plot_feature_importance(model, args.plot)
    
    # Save model
    save_model(model, args.output)
    
    print(f"\nTraining complete! Model saved as {args.output}")
    if hasattr(model, 'best_iteration'):
        print(f"Best iteration: {model.best_iteration}")
        print(f"Best score (logloss): {model.best_score:.4f}")
    else:
        print("Model training completed")


if __name__ == "__main__":
    main()
