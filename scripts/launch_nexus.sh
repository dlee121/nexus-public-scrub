#!/usr/bin/env bash
# launch_nexus.sh — Start Nexus in the background and exit.
# Run this on boot or whenever you want a clean restart.
# Orchestrator's daemon auto-starts Monitor on boot.
#
# Usage (from anywhere):
#   /path/to/Nexus/core/scripts/launch_nexus.sh

set -euo pipefail

CORE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENTITY_PATHS=(
  "$CORE"
  "$CORE/entities/monitor"
  "$CORE/entities/advisor"
  "$CORE/entities/engineer"
)

# ── Stop any running daemons ────────────────────────────────────────────────

echo "→ Stopping existing daemons..."
stopped=0
for entity_path in "${ENTITY_PATHS[@]}"; do
  pid_file="$entity_path/.claude/claudeclaw/daemon.pid"
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Wait up to 3s for clean exit
      for _ in $(seq 1 30); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      echo "  stopped PID $pid"
      ((stopped++)) || true
    fi
    rm -f "$pid_file"
  fi
done

# Catch any orphaned bun processes running Nexus
orphans=$(pgrep -f "bun.*Nexus/core/src/index.ts" 2>/dev/null || true)
if [[ -n "$orphans" ]]; then
  echo "$orphans" | xargs kill 2>/dev/null || true
  echo "  stopped orphaned bun processes"
  ((stopped++)) || true
fi

[[ $stopped -eq 0 ]] && echo "  nothing was running"

sleep 0.5  # let ports release

# ── Source MCP secrets if present ───────────────────────────────────────────
#
# .mcp.json references SLACK_BOT_TOKEN via ${VAR} substitution. That
# value must be in the parent process env when Claude Code (spawned
# later by Orchestrator / entities) loads the MCP server.
# .mcp-secrets.env is gitignored; .mcp-secrets.env.example documents the
# expected shape. Skip silently if the file isn't there — DK may have
# exports in shell rc instead.
if [[ -f "$CORE/.mcp-secrets.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CORE/.mcp-secrets.env"
  set +a
fi

# ── Start Orchestrator daemon ──────────────────────────────────────────────────────

echo "→ Starting Orchestrator..."

LOG="$CORE/.claude/claudeclaw/logs/daemon.log"
mkdir -p "$(dirname "$LOG")"

cd "$CORE"
nohup bun run src/index.ts start >> "$LOG" 2>&1 &
PRIME_PID=$!
disown $PRIME_PID
cd - > /dev/null

# ── Wait for Orchestrator to be healthy ────────────────────────────────────────────

echo -n "  Waiting"
ok=false
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4632/api/health > /dev/null 2>&1; then
    ok=true
    break
  fi
  echo -n "."
  sleep 0.5
done
echo ""

if [[ "$ok" != "true" ]]; then
  echo "  ✗ Orchestrator didn't respond — check logs: $LOG"
  exit 1
fi

# ── Done ────────────────────────────────────────────────────────────────────

echo "  ✓ Orchestrator  →  http://127.0.0.1:4632"
echo "  ✓ Monitor auto-starting in background"
echo ""
echo "Nexus is running."
echo "To interact: claude --plugin-dir $CORE"
