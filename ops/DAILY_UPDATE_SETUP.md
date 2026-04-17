# Daily IPL Auto-Update Setup (macOS)

This project includes a daily updater that:
- downloads latest IPL JSON from Cricsheet,
- merges new/changed matches into `ipl_male_json/`,
- rebuilds `ipl_innings_snapshots.csv`,
- refits model params,
- writes `model_params.json` (read automatically by app/API).

## One-time setup

1. Make the script executable:

```bash
chmod +x "/Users/shreyas/extended_essay_model/ops/run_daily_update.sh"
```

2. Load the launchd job:

```bash
mkdir -p "/Users/shreyas/extended_essay_model/ops/logs"
launchctl unload "$HOME/Library/LaunchAgents/com.shreyas.ipl-updater.plist" 2>/dev/null || true
cp "/Users/shreyas/extended_essay_model/ops/com.shreyas.ipl-updater.plist" "$HOME/Library/LaunchAgents/com.shreyas.ipl-updater.plist"
launchctl load "$HOME/Library/LaunchAgents/com.shreyas.ipl-updater.plist"
```

3. Trigger a manual run now (optional):

```bash
launchctl start com.shreyas.ipl-updater
```

## Why this is resilient when the laptop is off

- `StartCalendarInterval` runs daily at 06:30.
- `RunAtLoad` runs once when your Mac/logged-in session starts.
- The updater is idempotent: it compares match JSON contents and only adds/updates files when needed.

So if your machine was off at schedule time, it still catches up next login/boot.

## Logs

- Per-run logs: `ops/logs/update_YYYY-mm-dd_HH-MM-SS.log`
- launchd stdout/stderr:
  - `ops/logs/launchd_stdout.log`
  - `ops/logs/launchd_stderr.log`

