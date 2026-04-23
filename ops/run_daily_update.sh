#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/shreyas/extended_essay_model"
PYTHON_BIN="/usr/local/bin/python3"
LOG_DIR="$PROJECT_DIR/ops/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

TS="$(date +%Y-%m-%d_%H-%M-%S)"
LOG_FILE="$LOG_DIR/update_$TS.log"

{
  echo "[$(date)] Starting daily IPL update"
  "$PYTHON_BIN" "$PROJECT_DIR/scripts/update_ipl_daily.py"
  echo "[$(date)] Daily IPL update completed"
} >> "$LOG_FILE" 2>&1

