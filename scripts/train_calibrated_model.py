"""
train_calibrated_model.py
--------------------------
Train XGBoost model with proper probability calibration.
Uses CalibratedClassifierCV with isotonic regression for better probability calibration.

Usage:
    python train_calibrated_model.py --train_data train_with_momentum.csv --test_data test_data_2025.csv
"""

import pandas as pd
import numpy as np
import xgboost as xgb
import pickle
import argparse
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.model_selection import train_test_split
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.metrics import (log_loss, brier_score_loss, roc_auc_score, accuracy_score, 
                           classification_report, confusion_matrix)
import warnings
warnings.filterwarnings('ignore')

# Feature columns (including momentum)
FEATURE_COLS = [
    "legal_ball",
    "runs_scored", "wickets_fallen", "wickets_remaining", "balls_remaining", "runs_needed",
    "over", "crr", "rrr", "run_rate_diff",
    "pct_balls_used", "pct_runs_scored", "pct_wickets_fallen",
    "momentum_runs_12b", "momentum_wickets_12b", "momentum_run_rate_12b",
    "balls_since_last_wicket",
    "venue_avg_first_innings", "venue_chasing_efficiency", "target_vs_venue_avg",
    "projected_final_score", "projected_margin",
    "target_runs", "target_overs",
    "momentum_score", "recent_runs_rate", "recent_wicket_rate", "batting_pressure"
]

CATEGORICAL_COLS = ["phase"]


def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Prepare features for training."""
    df = df.copy()
    
    # Handle categorical variables
    if df["phase"].dtype.name == 'category':
        df["phase"] = df["phase"].cat.codes
    else:
        df["phase"] = pd.Categorical(df["phase"], categories=["powerplay", "middle", "death"], ordered=True).codes
    
    # Select features (handle missing momentum features)
    available_features = [col for col in FEATURE_COLS + CATEGORICAL_COLS if col in df.columns]
    X = df[available_features].copy()
    y = df["chasing_team_won"]
    
    return X, y


def train_base_model(X_train, y_train) -> xgb.XGBClassifier:
    """Train base XGBoost model."""
    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 6,
        "learning_rate": 0.05,
        "n_estimators": 400,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 1.0,
        "reg_lambda": 1.0,
        "min_child_weight": 1,
        "random_state": 42,
        "n_jobs": -1
    }
    
    # Emphasize high-leverage states so ball events move probability more.
    balls_remaining = X_train["balls_remaining"].clip(lower=1, upper=120)
    runs_needed = X_train["runs_needed"].clip(lower=0, upper=300)
    wickets_fallen = X_train["wickets_fallen"].clip(lower=0, upper=10)
    rrr = X_train["rrr"].clip(lower=0, upper=30)
    leverage = (
        1.0
        + 1.2 * (1.0 - balls_remaining / 120.0)
        + 1.0 * (runs_needed / balls_remaining)
        + 0.6 * (wickets_fallen / 10.0)
        + 0.8 * (rrr / 12.0)
    )
    sample_weight = leverage.clip(lower=1.0, upper=6.0)

    model = xgb.XGBClassifier(**params)
    model.fit(X_train, y_train, sample_weight=sample_weight)
    
    return model


def calibrate_model(base_model, X_calib, y_calib, method='isotonic') -> CalibratedClassifierCV:
    """
    Calibrate probabilities using isotonic regression or sigmoid.
    
    Args:
        base_model: Trained base model
        X_calib: Calibration features
        y_calib: Calibration targets
        method: 'isotonic' or 'sigmoid'
    
    Returns:
        Calibrated classifier
    """
    calibrated = CalibratedClassifierCV(
        base_model, 
        method=method, 
        cv='prefit'  # Use pre-trained model
    )
    
    calibrated.fit(X_calib, y_calib)
    return calibrated


def evaluate_calibrated_model(model, X_test, y_test, dataset_name="Test", is_calibrated=True):
    """Evaluate model with focus on calibration metrics."""
    # Get probabilities
    if is_calibrated:
        y_pred_proba = model.predict_proba(X_test)[:, 1]
    else:
        y_pred_proba = model.predict_proba(X_test)[:, 1]
    
    y_pred = (y_pred_proba >= 0.5).astype(int)
    
    # Calculate metrics
    metrics = {
        "log_loss": log_loss(y_test, y_pred_proba),
        "brier_score": brier_score_loss(y_test, y_pred_proba),
        "roc_auc": roc_auc_score(y_test, y_pred_proba),
        "accuracy": accuracy_score(y_test, y_pred)
    }
    
    print(f"\n=== {dataset_name} Set Performance ===")
    for metric, value in metrics.items():
        print(f"{metric}: {value:.4f}")
    
    # Classification report
    print(f"\n{dataset_name} Classification Report:")
    print(classification_report(y_test, y_pred, target_names=["Lost", "Won"]))
    
    return metrics, y_pred_proba


def plot_calibration_curve(y_true, y_pred_proba, n_bins=10, save_path=None):
    """Plot calibration curve."""
    prob_true, prob_pred = calibration_curve(y_true, y_pred_proba, n_bins=n_bins)
    
    plt.figure(figsize=(8, 6))
    plt.plot([0, 1], [0, 1], "k:", label="Perfectly calibrated")
    plt.plot(prob_pred, prob_true, "s-", label="Model")
    plt.xlabel("Mean predicted probability")
    plt.ylabel("Fraction of positives")
    plt.title("Calibration Curve")
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    if save_path:
        plt.savefig(save_path, dpi=300, bbox_inches='tight')
        print(f"Calibration curve saved to {save_path}")
    else:
        plt.show()


def analyze_calibration_bins(y_true, y_pred_proba, n_bins=10):
    """Analyze calibration by probability bins."""
    bins = np.linspace(0, 1, n_bins + 1)
    bin_labels = [f"{int(bins[i]*100)}-{int(bins[i+1]*100)}%" for i in range(n_bins)]
    
    df_analysis = pd.DataFrame({
        'predicted_prob': y_pred_proba,
        'actual': y_true
    })
    
    df_analysis['prob_bin'] = pd.cut(df_analysis['predicted_prob'], bins=bins, labels=bin_labels, include_lowest=True)
    
    calibration = df_analysis.groupby('prob_bin').agg({
        'actual': ['mean', 'count'],
        'predicted_prob': 'mean'
    }).round(3)
    
    calibration.columns = ['actual_win_rate', 'sample_size', 'avg_predicted_prob']
    
    print("\n=== Calibration Analysis by Bins ===")
    print(calibration)
    
    return calibration


def main():
    parser = argparse.ArgumentParser(description="Train calibrated XGBoost model")
    parser.add_argument("--train_data", required=True, help="Training data CSV")
    parser.add_argument("--test_data", required=True, help="Test data CSV")
    parser.add_argument("--model_output", default="calibrated_winprob_model.pkl", help="Model output")
    parser.add_argument("--base_model_output", default="base_winprob_model.pkl", help="Base model output")
    parser.add_argument("--calibration_plot", default="calibration_curve.png", help="Calibration plot")
    
    args = parser.parse_args()
    
    # Load data
    print(f"Loading training data from {args.train_data}...")
    train_df = pd.read_csv(args.train_data)
    print(f"Training data shape: {train_df.shape}")
    
    print(f"Loading test data from {args.test_data}...")
    test_df = pd.read_csv(args.test_data)
    print(f"Test data shape: {test_df.shape}")
    
    # Prepare features
    X_train_full, y_train_full = prepare_features(train_df)
    X_test, y_test = prepare_features(test_df)
    
    # Split training data for calibration
    X_train, X_calib, y_train, y_calib = train_test_split(
        X_train_full, y_train_full, test_size=0.3, random_state=42, stratify=y_train_full
    )
    
    print(f"Data split - Train: {X_train.shape}, Calibration: {X_calib.shape}, Test: {X_test.shape}")
    
    # Train base model
    print("\nTraining base XGBoost model...")
    base_model = train_base_model(X_train, y_train)
    
    # Save base model
    with open(args.base_model_output, "wb") as f:
        pickle.dump(base_model, f)
    print(f"Base model saved to {args.base_model_output}")
    
    # Evaluate base model (uncalibrated)
    print("\n=== Base Model (Uncalibrated) Performance ===")
    base_metrics, base_probs = evaluate_calibrated_model(base_model, X_test, y_test, "Test", is_calibrated=False)
    
    # Calibrate model
    print("\nCalibrating probabilities with sigmoid (Platt scaling)...")
    calibrated_model = calibrate_model(base_model, X_calib, y_calib, method='sigmoid')
    
    # Save calibrated model
    with open(args.model_output, "wb") as f:
        pickle.dump(calibrated_model, f)
    print(f"Calibrated model saved to {args.model_output}")
    
    # Evaluate calibrated model
    print("\n=== Calibrated Model Performance ===")
    calib_metrics, calib_probs = evaluate_calibrated_model(calibrated_model, X_test, y_test, "Test", is_calibrated=True)
    
    # Compare performance
    print(f"\n=== Performance Comparison ===")
    print(f"{'Metric':<15} {'Base':<12} {'Calibrated':<12} {'Improvement':<12}")
    print("-" * 55)
    for metric in base_metrics.keys():
        base_val = base_metrics[metric]
        calib_val = calib_metrics[metric]
        
        if metric in ['log_loss', 'brier_score']:
            # Lower is better
            improvement = (base_val - calib_val) / base_val * 100
            imp_str = f"{improvement:+.1f}%"
        else:
            # Higher is better
            improvement = (calib_val - base_val) / base_val * 100
            imp_str = f"{improvement:+.1f}%"
        
        print(f"{metric:<15} {base_val:<12.4f} {calib_val:<12.4f} {imp_str:<12}")
    
    # Calibration analysis
    print("\n=== Base Model Calibration ===")
    base_calibration = analyze_calibration_bins(y_test, base_probs)
    
    print("\n=== Calibrated Model Calibration ===")
    calib_calibration = analyze_calibration_bins(y_test, calib_probs)
    
    # Plot calibration curves
    plt.figure(figsize=(12, 5))
    
    plt.subplot(1, 2, 1)
    prob_true, prob_pred = calibration_curve(y_test, base_probs, n_bins=10)
    plt.plot([0, 1], [0, 1], "k:", label="Perfect")
    plt.plot(prob_pred, prob_true, "s-", label="Base Model")
    plt.xlabel("Mean predicted probability")
    plt.ylabel("Fraction of positives")
    plt.title("Base Model Calibration")
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    plt.subplot(1, 2, 2)
    prob_true, prob_pred = calibration_curve(y_test, calib_probs, n_bins=10)
    plt.plot([0, 1], [0, 1], "k:", label="Perfect")
    plt.plot(prob_pred, prob_true, "s-", label="Calibrated Model")
    plt.xlabel("Mean predicted probability")
    plt.ylabel("Fraction of positives")
    plt.title("Calibrated Model Calibration")
    plt.legend()
    plt.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(args.calibration_plot, dpi=300, bbox_inches='tight')
    print(f"\nCalibration plots saved to {args.calibration_plot}")
    
    print(f"\n=== Summary ===")
    print(f"Base model Brier Score: {base_metrics['brier_score']:.4f}")
    print(f"Calibrated Brier Score: {calib_metrics['brier_score']:.4f}")
    print(f"Calibration improvement: {(base_metrics['brier_score'] - calib_metrics['brier_score']) / base_metrics['brier_score'] * 100:+.1f}%")


if __name__ == "__main__":
    main()
