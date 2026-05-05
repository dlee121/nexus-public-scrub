#!/usr/bin/env bash
# ============================================================
# Cron installer for Nexus Content Pipeline
# Usage: bash scripts/content/cron.sh [install|remove|status]
# ============================================================

set -euo pipefail

NEXUS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN_BIN="$(which bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
PIPELINE="$NEXUS_ROOT/scripts/content/pipeline.ts"
LOG_DIR="$NEXUS_ROOT/data/content/logs"
MARKER="# nexus-content-pipeline"

install_cron() {
  mkdir -p "$LOG_DIR"

  # Remove existing entries first
  crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - 2>/dev/null || true

  # Build new crontab entries
  ENTRIES=$(crontab -l 2>/dev/null || echo "")
  ENTRIES="$ENTRIES
$MARKER
# Daily SEO articles: 8am ET (adjust TZ offset as needed)
0 8 * * * cd $NEXUS_ROOT && $BUN_BIN $PIPELINE daily >> $LOG_DIR/daily-\$(date +\%Y-\%m-\%d).log 2>&1 $MARKER
# Weekly Medium article: Tuesday 9am ET
0 9 * * 2 cd $NEXUS_ROOT && $BUN_BIN $PIPELINE medium --write --publish >> $LOG_DIR/medium-\$(date +\%Y-\%m-\%d).log 2>&1 $MARKER
# Hourly queue status check (silent unless queue is stuck)
0 * * * * cd $NEXUS_ROOT && $BUN_BIN $PIPELINE status >> $LOG_DIR/status.log 2>&1 $MARKER"

  echo "$ENTRIES" | crontab -
  echo "✓ Cron jobs installed:"
  crontab -l | grep "$MARKER" -B1 | grep -v "$MARKER"
  echo ""
  echo "Logs will write to: $LOG_DIR/"
}

remove_cron() {
  crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - 2>/dev/null || true
  echo "✓ Content pipeline cron jobs removed"
}

status_cron() {
  echo "=== Current pipeline cron jobs ==="
  crontab -l 2>/dev/null | grep -A1 "$MARKER" | grep -v "$MARKER" | grep -v "^--$" || echo "(none installed)"
  echo ""
  echo "=== Recent logs ==="
  if [ -d "$LOG_DIR" ]; then
    ls -lt "$LOG_DIR"/*.log 2>/dev/null | head -5 || echo "(no logs yet)"
    echo ""
    LATEST=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
    if [ -n "$LATEST" ]; then
      echo "--- Latest: $LATEST ---"
      tail -20 "$LATEST"
    fi
  else
    echo "(log dir not created yet)"
  fi
}

CMD="${1:-install}"
case "$CMD" in
  install) install_cron ;;
  remove)  remove_cron  ;;
  status)  status_cron  ;;
  *)       echo "Usage: $0 [install|remove|status]"; exit 1 ;;
esac
