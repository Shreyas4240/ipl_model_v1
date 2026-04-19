"""
train_and_evaluate_split.py
---------------------------
Train XGBoost model on 2022-2024 data and evaluate on 2025 data.
This provides a proper temporal evaluation of model performance.

Usage:
    python train_and_evaluate_split.py --train_data train_data_2022_2024.csv --test_data test_data_2025.csv
"""

import pandas as pd
import numpy as np
import xgboost as xgb
import pickle
import argparse
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.metrics import log_loss, brier_score_loss, roc_auc_score, accuracy_score, classification_report, confusion_matrix

# Feature columns (must match training data)
FEATURE_COLS = [
    "legal_ball",
    "runs_scored", "wickets_fallen", "wickets_remaining", "balls_remaining", "runs_needed",
    "over", "crr", "rrr", "run_rate_diff",
    "pct_balls_used", "pct_runs_scored", "pct_wickets_fallen",
    "momentum_runs_12b", "momentum_wickets_12b", "momentum_run_rate_12b",
    "balls_since_last_wicket",
    "venue_avg_first_innings", "venue_chasing_efficiency", "target_vs_venue_avg",
    "target_runs", "target_overs"
]

CATEGORICAL_COLS = ["phase"]


def prepare_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Prepare features for XGBoost training."""
    df = df.copy()
    
    # Handle categorical variables
    if df["phase"].dtype.name == 'category':
        df["phase"] = df["phase"].cat.codes
    else:
        df["phase"] = pd.Categorical(df["phase"], categories=["powerplay", "middle", "death"], ordered=True).codes
    
    # Select features
    X = df[FEATURE_COLS + CATEGORICAL_COLS].copy()
    y = df["chasing_team_won"]
    
    return X, y


def train_model(X_train, y_train, X_val, y_val) -> xgb.XGBClassifier:
    """Train XGBoost model with validation."""
    params = {
        "objective": "binary:logistic",
        "eval_metric": "logloss",
        "max_depth": 6,
        "learning_rate": 0.05,
        "n_estimators": 500,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "reg_alpha": 1.0,
        "reg_lambda": 1.0,
        "min_child_weight": 1,
        "random_state": 42,
        "n_jobs": -1
    }
    
    model = xgb.XGBClassifier(**params)
    
    # Simple training (no early stopping for compatibility)
    model.fit(X_train, y_train)
    
    return model


def evaluate_model(model: xgb.XGBClassifier, X_test, y_test, dataset_name="Test") -> dict:
    """Evaluate model performance with comprehensive metrics."""
    # Predict probabilities and classes
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
    
    # Detailed classification report
    print(f"\n{dataset_name} Classification Report:")
    print(classification_report(y_test, y_pred, target_names=["Lost", "Won"]))
    
    # Confusion matrix
    cm = confusion_matrix(y_test, y_pred)
    plt.figure(figsize=(6, 4))
    sns.heatmap(cm, annot=True, fmt='d', cmap='Blues', 
                xticklabels=['Lost', 'Won'], yticklabels=['Lost', 'Won'])
    plt.title(f'{dataset_name} Confusion Matrix')
    plt.ylabel('Actual')
    plt.xlabel('Predicted')
    plt.tight_layout()
    plt.savefig(f'confusion_matrix_{dataset_name.lower()}.png', dpi=300, bbox_inches='tight')
    plt.show()
    
    return metrics


def plot_feature_importance(model: xgb.XGBClassifier, save_path: str = None):
    """Plot feature importance."""
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
        plt.savefig(save_path, dpi=300, bbox_inches='tight')
        print(f"Feature importance plot saved to {save_path}")
    else:
        plt.show()


def analyze_predictions(model: xgb.XGBClassifier, X_test, y_test):
    """Analyze prediction patterns and calibration."""
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    
    # Create bins for analysis
    bins = np.linspace(0, 1, 11)
    bin_labels = [f"{i*10}-{(i+1)*10}%" for i in range(10)]
    
    df_analysis = pd.DataFrame({
        'predicted_prob': y_pred_proba,
        'actual': y_test
    })
    
    df_analysis['prob_bin'] = pd.cut(df_analysis['predicted_prob'], bins=bins, labels=bin_labels, include_lowest=True)
    
    # Calculate actual win rate by predicted probability bin
    calibration = df_analysis.groupby('prob_bin').agg({
        'actual': ['mean', 'count']
    }).round(3)
    
    calibration.columns = ['actual_win_rate', 'sample_size']
    calibration['predicted_prob_mid'] = [i*0.05 + 0.05 for i in range(10)]
    
    print("\n=== Calibration Analysis ===")
    print(calibration)
    
    # Plot calibration curve
    plt.figure(figsize=(8, 6))
    plt.plot([0, 1], [0, 1], 'k--', label='Perfect Calibration')
    plt.scatter(calibration['predicted_prob_mid'], calibration['actual_win_rate'], 
                s=calibration['sample_size']*10, alpha=0.7, label='Model Predictions')
    plt.xlabel('Predicted Probability')
    plt.ylabel('Actual Win Rate')
    plt.title('Calibration Curve')
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig('calibration_curve.png', dpi=300, bbox_inches='tight')
    plt.show()
    
    return calibration


def main():
    parser = argparse.ArgumentParser(description="Train on 2022-2024, evaluate on 2025")
    parser.add_argument("--train_data", required=True, help="Training data CSV (2022-2024)")
    parser.add_argument("--test_data", required=True, help="Test data CSV (2025)")
    parser.add_argument("--model_output", default="winprob_model_2022_2024.pkl", help="Model output file")
    parser.add_argument("--feature_plot", default="feature_importance_2022_2024.png", help="Feature importance plot")
    args = parser.parse_args()
    
    # Load data
    print(f"Loading training data from {args.train_data}...")
    train_df = pd.read_csv(args.train_data)
    print(f"Training data shape: {train_df.shape}")
    
    print(f"Loading test data from {args.test_data}...")
    test_df = pd.read_csv(args.test_data)
    print(f"Test data shape: {test_df.shape}")
    
    # Prepare features
    X_train, y_train = prepare_features(train_df)
    X_test, y_test = prepare_features(test_df)
    
    # Further split training data for validation
    from sklearn.model_selection import train_test_split
    X_train_split, X_val, y_train_split, y_val = train_test_split(
        X_train, y_train, test_size=0.2, random_state=42, stratify=y_train
    )
    
    print(f"Final split - Train: {X_train_split.shape}, Val: {X_val.shape}, Test: {X_test.shape}")
    
    # Train model
    print("\nTraining XGBoost model on 2022-2024 data...")
    model = train_model(X_train_split, y_train_split, X_val, y_val)
    
    # Evaluate on validation set
    val_metrics = evaluate_model(model, X_val, y_val, "Validation")
    
    # Evaluate on test set (2025 data)
    test_metrics = evaluate_model(model, X_test, y_test, "Test (2025)")
    
    # Compare performance
    print(f"\n=== Performance Comparison ===")
    print(f"{'Metric':<15} {'Validation':<12} {'Test (2025)':<12}")
    print("-" * 40)
    for metric in val_metrics.keys():
        print(f"{metric:<15} {val_metrics[metric]:<12.4f} {test_metrics[metric]:<12.4f}")
    
    # Feature importance
    plot_feature_importance(model, args.feature_plot)
    
    # Calibration analysis
    calibration = analyze_predictions(model, X_test, y_test)
    
    # Save model
    with open(args.model_output, "wb") as f:
        pickle.dump(model, f)
    print(f"\nModel saved to {args.model_output}")
    
    print(f"\n=== Summary ===")
    print(f"Trained on {len(train_df)} rows from 2022-2024")
    print(f"Tested on {len(test_df)} rows from 2025")
    print(f"Test ROC AUC: {test_metrics['roc_auc']:.4f}")
    print(f"Test Log Loss: {test_metrics['log_loss']:.4f}")
    print(f"Test Accuracy: {test_metrics['accuracy']:.4f}")


if __name__ == "__main__":
    main()
