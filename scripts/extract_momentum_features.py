"""
extract_momentum_features.py
---------------------------
Extract momentum features using LSTM for win probability model.
Creates a short-window momentum feature that captures batting collapses/momentum shifts.

Usage:
    python extract_momentum_features.py --data train_data_2022_2024.csv --output train_with_momentum.csv
"""

import pandas as pd
import numpy as np
import pickle
import argparse
from sklearn.preprocessing import StandardScaler
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
from tensorflow.keras.optimizers import Adam
import warnings
warnings.filterwarnings('ignore')


def prepare_sequences(df: pd.DataFrame, window_size: int = 10) -> tuple:
    """
    Prepare sequences for LSTM training from match data.
    
    Args:
        df: DataFrame with match data
        window_size: Number of recent balls to consider (5-10 recommended)
    
    Returns:
        X: Sequences of shape (n_sequences, window_size, n_features)
        y: Target (next ball outcome)
        metadata: Match metadata for reconstruction
    """
    sequences = []
    targets = []
    metadata = []
    
    # Group by match_id to maintain temporal order within matches
    for match_id, match_df in df.groupby('match_id'):
        # Sort by legal_ball to maintain chronological order
        match_df = match_df.sort_values('legal_ball')
        
        # Features for momentum modeling
        feature_cols = [
            'runs_scored', 'wickets_fallen', 'balls_remaining', 'runs_needed',
            'crr', 'rrr', 'run_rate_diff', 'momentum_runs_12b', 'momentum_wickets_12b'
        ]
        
        # Create sequences
        match_data = match_df[feature_cols].values
        match_targets = match_df['chasing_team_won'].values
        
        for i in range(window_size, len(match_data)):
            # Sequence of last `window_size` balls
            seq = match_data[i-window_size:i]
            
            # Target: does the chasing team eventually win this match?
            target = match_targets[i]
            
            sequences.append(seq)
            targets.append(target)
            metadata.append({
                'match_id': match_id,
                'legal_ball': match_df.iloc[i]['legal_ball'],
                'over': match_df.iloc[i]['over']
            })
    
    return np.array(sequences), np.array(targets), metadata


def build_momentum_lstm(input_shape: int, window_size: int) -> tf.keras.Model:
    """
    Build LSTM model for momentum feature extraction.
    
    Args:
        input_shape: Number of features per time step
        window_size: Sequence length
    
    Returns:
        Compiled LSTM model
    """
    model = Sequential([
        LSTM(32, return_sequences=True, input_shape=(window_size, input_shape)),
        Dropout(0.2),
        LSTM(16, return_sequences=False),
        Dropout(0.2),
        Dense(8, activation='relu'),
        Dense(1, activation='sigmoid')  # Predict win probability
    ])
    
    model.compile(
        optimizer=Adam(learning_rate=0.001),
        loss='binary_crossentropy',
        metrics=['accuracy']
    )
    
    return model


def extract_momentum_features(model, df: pd.DataFrame, window_size: int = 10) -> pd.DataFrame:
    """
    Extract momentum features using trained LSTM.
    
    Args:
        model: Trained LSTM model
        df: Match data
        window_size: Sequence window size
    
    Returns:
        DataFrame with added momentum features
    """
    df_with_momentum = df.copy()
    momentum_scores = []
    
    # Process each match
    for match_id, match_df in df.groupby('match_id'):
        match_df = match_df.sort_values('legal_ball')
        
        # Prepare sequences for this match
        feature_cols = [
            'runs_scored', 'wickets_fallen', 'balls_remaining', 'runs_needed',
            'crr', 'rrr', 'run_rate_diff', 'momentum_runs_12b', 'momentum_wickets_12b'
        ]
        
        match_data = match_df[feature_cols].values
        match_momentum = []
        
        # For each position, extract momentum from preceding window
        for i in range(len(match_data)):
            if i < window_size - 1:
                # Not enough history, use neutral momentum
                match_momentum.append(0.5)
            else:
                # Extract momentum from last window_size balls
                seq = match_data[i-window_size+1:i+1].reshape(1, window_size, -1)
                momentum_pred = model.predict(seq, verbose=0)[0, 0]
                match_momentum.append(momentum_pred)
        
        momentum_scores.extend(match_momentum)
    
    # Add momentum features
    df_with_momentum['lstm_momentum'] = momentum_scores
    df_with_momentum['lstm_momentum_adjusted'] = df_with_momentum['lstm_momentum'] * 100  # Scale to 0-100
    
    # Create momentum change feature (derivative)
    df_with_momentum['momentum_change'] = df_with_momentum.groupby('match_id')['lstm_momentum'].diff().fillna(0)
    
    return df_with_momentum


def main():
    parser = argparse.ArgumentParser(description="Extract LSTM momentum features")
    parser.add_argument("--data", required=True, help="Input CSV file")
    parser.add_argument("--output", required=True, help="Output CSV file")
    parser.add_argument("--window_size", type=int, default=10, help="Window size for LSTM")
    parser.add_argument("--model_output", default="momentum_lstm_model.h5", help="LSTM model output")
    parser.add_argument("--test_split", type=float, default=0.2, help="Test split ratio")
    
    args = parser.parse_args()
    
    print(f"Loading data from {args.data}...")
    df = pd.read_csv(args.data)
    print(f"Data shape: {df.shape}")
    
    # Prepare sequences
    print(f"Preparing sequences with window size {args.window_size}...")
    X, y, metadata = prepare_sequences(df, args.window_size)
    print(f"Sequences shape: {X.shape}")
    
    # Split data
    split_idx = int(len(X) * (1 - args.test_split))
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]
    
    print(f"Training: {X_train.shape}, Test: {X_test.shape}")
    
    # Build and train LSTM
    print("Training LSTM momentum model...")
    model = build_momentum_lstm(X_train.shape[2], args.window_size)
    
    history = model.fit(
        X_train, y_train,
        validation_data=(X_test, y_test),
        epochs=20,
        batch_size=32,
        verbose=1
    )
    
    # Evaluate
    loss, accuracy = model.evaluate(X_test, y_test, verbose=0)
    print(f"Test Loss: {loss:.4f}, Test Accuracy: {accuracy:.4f}")
    
    # Save model
    model.save(args.model_output)
    print(f"LSTM model saved to {args.model_output}")
    
    # Extract momentum features for full dataset
    print("Extracting momentum features...")
    df_with_momentum = extract_momentum_features(model, df, args.window_size)
    
    # Save enhanced dataset
    df_with_momentum.to_csv(args.output, index=False)
    print(f"Enhanced dataset saved to {args.output}")
    
    # Display momentum statistics
    print(f"\nMomentum feature statistics:")
    print(df_with_momentum['lstm_momentum'].describe())
    
    print(f"\nMomentum vs actual wins:")
    momentum_bins = pd.qcut(df_with_momentum['lstm_momentum'], 5, labels=['Very Low', 'Low', 'Medium', 'High', 'Very High'])
    momentum_analysis = df_with_momentum.groupby(momentum_bins)['chasing_team_won'].agg(['mean', 'count'])
    print(momentum_analysis)


if __name__ == "__main__":
    main()
