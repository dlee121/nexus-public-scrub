#!/usr/bin/env bash
# run-pipeline-detached.sh
# Runs the daily content pipeline and sends a Telegram summary on completion.
# Designed to be launched via nohup so it survives Claude Code session teardown.

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be provided by the runtime environment." >&2
  exit 1
fi

PIPELINE="bun /Users/<user>/Nexus/core/scripts/content/pipeline.ts"
LOG_FILE="/tmp/nexus-pipeline-output.log"

send_telegram() {
  local text="$1"
  # Defensive: strip literal "\n" / "\r" / "\t" sequences that may have crept
  # in via JSON-stringified upstream errors. Without this, Telegram displays
  # them as the two-character literal `\n` instead of a line break, since
  # neither curl nor the API converts JSON-escaped sequences in form-encoded
  # form fields.
  text="${text//\\n/ }"
  text="${text//\\r/ }"
  text="${text//\\t/ }"
  # Use --data-urlencode (NOT -d) so newlines, ampersands, and other special
  # chars in the message survive curl's form-encoding intact. With plain -d,
  # an unescaped `&` in an article title would split the request body and
  # corrupt the message.
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    > /dev/null 2>&1
}

# Run the pipeline, capturing all output. Do NOT use set -e here so we always
# reach the Telegram notification step even if the pipeline exits non-zero.
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting daily content pipeline..." | tee "$LOG_FILE"

$PIPELINE daily >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pipeline exited with code $EXIT_CODE" | tee -a "$LOG_FILE"

if [ $EXIT_CODE -ne 0 ]; then
  # Extract last meaningful error line for the notification.
  #   -i: case-insensitive — Bun runtime emits lowercase "error:" in stack
  #       traces, while pipeline.ts logs uppercase "ERROR:" / "FAILED:".
  #       Without -i the bash extractor missed Bun's traces entirely and
  #       the operator got a useless "exit code 1" telegram.
  LAST_ERROR=$(grep -iE "^.*(FAILED:|ERROR:|^error:)" "$LOG_FILE" | tail -5 | sed 's/\[.*\] //' | tr '\n' ' ' | cut -c1-400)
  if [ -z "$LAST_ERROR" ]; then
    # Fallback: dump the tail of the log so the operator always gets real
    # context, never just "exit code N". Trim hard for Telegram readability.
    LAST_ERROR=$(tail -30 "$LOG_FILE" | grep -v '^$' | tail -10 | tr '\n' ' ' | cut -c1-400)
    if [ -z "$LAST_ERROR" ]; then
      LAST_ERROR="exit code $EXIT_CODE (log empty) — check /tmp/nexus-pipeline-output.log"
    fi
  fi
  send_telegram "content pipeline FAILED (exit $EXIT_CODE): $LAST_ERROR"
  exit $EXIT_CODE
fi

# Parse per-site publish counts.
# pipeline.ts logs: Published: https://<domain>/...
# Site → domain mapping:
#   ai-tools    → bizrunbook.com
#   productivity → autoflowguide.com
#   saas        → saassleuth.com

count_site() {
  local domain="$1"
  grep -c "Published: https://${domain}" "$LOG_FILE" 2>/dev/null || echo 0
}

BIZRUNBOOK=$(count_site "bizrunbook.com")
AUTOFLOWGUIDE=$(count_site "autoflowguide.com")
SAASSLEUTH=$(count_site "saassleuth.com")

# Check for any FAILED lines to flag partial failures
FAILED_COUNT=$(grep -c "^.*\] FAILED:" "$LOG_FILE" 2>/dev/null || echo 0)

MESSAGE="pipeline done"
if [ "$FAILED_COUNT" -gt 0 ]; then
  FAILED_DETAILS=$(grep "FAILED:" "$LOG_FILE" | sed 's/\[.*\] //' | head -3 | tr '\n' ' ' | cut -c1-200)
  MESSAGE="pipeline done (${FAILED_COUNT} failure(s)) — bizrunbook: ${BIZRUNBOOK}, autoflowguide: ${AUTOFLOWGUIDE}, saassleuth: ${SAASSLEUTH} — ${FAILED_DETAILS}"
else
  MESSAGE="pipeline done — bizrunbook: ${BIZRUNBOOK}, autoflowguide: ${AUTOFLOWGUIDE}, saassleuth: ${SAASSLEUTH}"
fi

send_telegram "$MESSAGE"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Telegram notification sent: $MESSAGE" | tee -a "$LOG_FILE"
