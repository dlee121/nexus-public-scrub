#!/usr/bin/env bash
#
# claude-creds-refresh.sh — EC2-resident OAuth refresh for Claude Code.
#
# Runs as the canonical refresh authority for the forge-worker's
# /root/.claude/.credentials.json. Replaces the prior Mac → EC2 launchd
# SCP loop, which silently failed whenever the Mac was asleep.
#
# Behavior (idempotent):
#   - Read /root/.claude/.credentials.json.
#   - If access token has >REFRESH_THRESHOLD_S remaining, exit 0 (no-op).
#   - Else, exchange refreshToken at platform.claude.com/v1/oauth/token,
#     atomically rewrite the file (tmp + rename), keep one .bak.
#
# Exit codes (visible in systemd journal):
#   0  ok / not-yet-needed / backoff-active (deliberate skip)
#   2  another instance running (flock contention)
#   3  creds file missing
#   4  refreshToken missing/empty
#   5  OAuth endpoint returned non-200 (alerts to Slack on the way out)
#   6  OAuth 200 but no access_token in body
#   7  jq composition failed
#
# Designed to be called by /etc/systemd/system/claude-creds-refresh.timer.

set -euo pipefail

CREDS_FILE="${CREDS_FILE:-/root/.claude/.credentials.json}"
# forge-console runs as User=ubuntu, so it reads the ubuntu copy.
# After refreshing root's file we replicate to ubuntu's so both Claude
# Code consumers see the same access token. Set to empty to disable.
MIRROR_FILE="${MIRROR_FILE:-/home/ubuntu/.claude/.credentials.json}"
MIRROR_OWNER="${MIRROR_OWNER:-ubuntu:ubuntu}"
OAUTH_URL="https://platform.claude.com/v1/oauth/token"
# Public OAuth client_id baked into the Claude Code binary; not a secret.
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
# Refresh when access token has less than this much life remaining.
# Token TTL is ~8h; threshold of 6h gives the timer (30-min cadence)
# twelve scheduled ticks before any consumer would 401, and combined
# with the 1h backoff window below allows up to ~6 OAuth attempts
# inside the runway after the first 429. Env-overridable for ad-hoc
# testing (e.g., REFRESH_THRESHOLD_MS=99999999 to force).
REFRESH_THRESHOLD_MS=${REFRESH_THRESHOLD_MS:-$(( 6 * 60 * 60 * 1000 ))}

LOCK_FILE="/run/claude-creds-refresh.lock"

# Backoff marker for Patch 4. Written when Anthropic returns 429
# (rate-limit), checked at the top of every run. While it's <BACKOFF_WINDOW_S
# old, the script skips the OAuth call entirely and exits 0. This stops
# the timer from hammering Anthropic when the refresh_token is invalid
# (typical cause: a fresh /login on the Mac that hasn't been bootstrapped
# to EC2 yet — see scripts/sync-claude-creds.sh --ec2-bootstrap).
BACKOFF_FILE="/run/claude-creds-refresh-backoff"
BACKOFF_WINDOW_S=$(( 1 * 60 * 60 ))  # 1h

# Slack notify channel for Patch 3. SLACK_XOXB_TOKEN is read from
# /run/forge-worker.env (already populated by forge-secrets.service from
# AWS Secrets Manager); if absent, notify_slack is a logged no-op.
SLACK_CHANNEL="${SLACK_CHANNEL:-[slack-id]}"  # [bot-user]'s own channel; [bot-user] is a member
FORGE_ENV_FILE="${FORGE_ENV_FILE:-/run/forge-worker.env}"

log() { echo "[claude-creds-refresh] $*" >&2; }

# Patch 3 — Slack notifier for persistent OAuth failures. Reads the
# SLACK_XOXB_TOKEN out of /run/forge-worker.env (without polluting our
# env), POSTs a chat.postMessage. All failures here are non-fatal and
# logged; we don't want a Slack outage to mask the underlying creds
# failure that triggered this notification.
notify_slack() {
  local message="$1"
  local token=""
  if [[ -f "$FORGE_ENV_FILE" ]]; then
    # Guard against pipefail when the var isn't present: { grep || true; }
    # ensures the pipeline still produces (empty) output rather than
    # aborting the whole script.
    token=$( { grep -E '^SLACK_XOXB_TOKEN=' "$FORGE_ENV_FILE" 2>/dev/null || true; } \
            | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" )
  fi
  if [[ -z "$token" ]]; then
    log "Slack notify skipped: SLACK_XOXB_TOKEN missing from $FORGE_ENV_FILE"
    return 0
  fi
  local payload
  payload=$(jq -nc \
    --arg ch "$SLACK_CHANNEL" \
    --arg t "$message" \
    '{channel:$ch, text:$t}' 2>/dev/null) || {
    log "Slack notify skipped: jq payload compose failed"
    return 0
  }
  local resp http
  resp=$(mktemp /tmp/.slack-resp.XXXXXX)
  chmod 600 "$resp"
  http=$(curl --silent --max-time 10 \
    -X POST https://slack.com/api/chat.postMessage \
    -H "Authorization: Bearer $token" \
    -H "Content-type: application/json; charset=utf-8" \
    --data "$payload" \
    --output "$resp" --write-out "%{http_code}" 2>/dev/null) || http="000"
  if [[ "$http" != "200" ]]; then
    log "Slack notify HTTP $http (body: $(head -c 200 "$resp" 2>/dev/null || echo unparseable))"
  else
    local ok
    ok=$(jq -r '.ok' "$resp" 2>/dev/null || echo "")
    if [[ "$ok" != "true" ]]; then
      log "Slack notify .ok=$ok ($(jq -r '.error // empty' "$resp" 2>/dev/null))"
    else
      log "Slack notify sent to $SLACK_CHANNEL"
    fi
  fi
  rm -f "$resp"
}

# Replicate CREDS_FILE → MIRROR_FILE if MIRROR_FILE is set and content drifts.
# Atomic via tmp+rename in the mirror's parent dir. No-op when content matches.
# Failures here are non-fatal: log and continue (forge-worker still has fresh
# creds via CREDS_FILE; only forge-console would lag).
mirror_creds() {
  [[ -z "$MIRROR_FILE" ]] && return 0
  local mirror_dir; mirror_dir=$(dirname "$MIRROR_FILE")
  if [[ ! -d "$mirror_dir" ]]; then
    log "mirror dir $mirror_dir absent; skipping mirror"
    return 0
  fi
  if [[ -f "$MIRROR_FILE" ]] && cmp -s "$CREDS_FILE" "$MIRROR_FILE"; then
    return 0
  fi
  local tmp; tmp=$(mktemp "${MIRROR_FILE}.XXXXXX") || { log "mirror tmp mktemp failed"; return 1; }
  chmod 600 "$tmp"
  if ! cp "$CREDS_FILE" "$tmp"; then
    log "mirror cp failed"
    rm -f "$tmp"
    return 1
  fi
  if [[ -n "$MIRROR_OWNER" ]]; then
    chown "$MIRROR_OWNER" "$tmp" 2>/dev/null || log "mirror chown $MIRROR_OWNER failed (continuing)"
  fi
  if ! mv -f "$tmp" "$MIRROR_FILE"; then
    log "mirror rename failed"
    rm -f "$tmp"
    return 1
  fi
  log "mirrored to $MIRROR_FILE"
}

if [[ ! -f "$CREDS_FILE" ]]; then
  log "creds file not found at $CREDS_FILE"
  exit 3
fi

# Cross-invocation lock so a manual run can't collide with the timer.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another refresh in progress; exiting"
  exit 2
fi

NOW_MS=$(( $(date +%s) * 1000 ))
EXPIRES_MS=$(jq -r '.claudeAiOauth.expiresAt // empty' "$CREDS_FILE" 2>/dev/null || echo "")
if [[ -z "$EXPIRES_MS" || ! "$EXPIRES_MS" =~ ^[0-9]+$ ]]; then
  log "expiresAt missing/malformed; refreshing unconditionally"
  EXPIRES_MS=0
fi

DELTA_MS=$(( EXPIRES_MS - NOW_MS ))
if (( DELTA_MS > REFRESH_THRESHOLD_MS )); then
  log "ok: $((DELTA_MS / 60000))min remaining; threshold $((REFRESH_THRESHOLD_MS / 60000))min; skipping"
  # Even on no-op, ensure the ubuntu mirror matches root (recovers any drift).
  mirror_creds
  exit 0
fi

# Patch 4 — exponential backoff. Earlier runs that hit 429 dropped a
# marker file with their timestamp. Honor it here: skip the OAuth call
# entirely while it's <BACKOFF_WINDOW_S old. Beyond that, treat as stale
# and clean up. This stops the 30-min timer from hammering Anthropic
# while a known-bad refresh_token sits in the creds file (typical cause:
# a fresh /login on the Mac that hasn't been --ec2-bootstrap'd over).
if [[ -f "$BACKOFF_FILE" ]]; then
  marker_age_s=$(( $(date +%s) - $(stat -c %Y "$BACKOFF_FILE" 2>/dev/null || echo 0) ))
  if (( marker_age_s < BACKOFF_WINDOW_S )); then
    remaining_min=$(( (BACKOFF_WINDOW_S - marker_age_s) / 60 ))
    log "backoff active: marker is ${marker_age_s}s old (<${BACKOFF_WINDOW_S}s window); skipping OAuth call. Will retry naturally in ~${remaining_min}min."
    exit 0
  fi
  log "backoff marker found but ${marker_age_s}s old (>=${BACKOFF_WINDOW_S}s window); clearing and continuing"
  rm -f "$BACKOFF_FILE"
fi

REFRESH_TOKEN=$(jq -r '.claudeAiOauth.refreshToken // empty' "$CREDS_FILE" 2>/dev/null || echo "")
if [[ -z "$REFRESH_TOKEN" || "$REFRESH_TOKEN" == "null" ]]; then
  log "refreshToken missing in creds file"
  exit 4
fi

RESP=$(mktemp /tmp/.claude-refresh-resp.XXXXXX)
chmod 600 "$RESP"
trap 'rm -f "$RESP"' EXIT

HTTP=$(curl --silent --max-time 20 \
  --output "$RESP" --write-out "%{http_code}" \
  -X POST "$OAUTH_URL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "Accept: application/json" \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "refresh_token=${REFRESH_TOKEN}" \
  --data-urlencode "client_id=${CLIENT_ID}" 2>/dev/null) || HTTP="000"

if [[ "$HTTP" != "200" ]]; then
  ERR=$(jq -r '.error // .type // "unknown"' "$RESP" 2>/dev/null || echo "unparseable")
  DESC=$(jq -r '.error_description // .message // ""' "$RESP" 2>/dev/null || echo "")
  log "OAuth refresh HTTP=$HTTP error=$ERR${DESC:+ desc=$DESC}"

  # Patch 4 — drop a backoff marker so the next 30-min tick (and any
  # subsequent ticks within BACKOFF_WINDOW_S) skip the OAuth call. Most
  # critical for HTTP 429 (rate limit, where retrying makes things
  # worse), but we also drop it for 401/403/4xx-invalid_grant — those
  # all indicate the refresh_token itself is bad and only operator
  # action (a fresh /login + --ec2-bootstrap) will fix it.
  if [[ "$HTTP" == "429" || "$HTTP" =~ ^4 ]]; then
    : > "$BACKOFF_FILE"
    log "wrote backoff marker $BACKOFF_FILE — next ${BACKOFF_WINDOW_S}s of timer ticks will skip"
  fi

  # Patch 3 — Slack notify so DK isn't blind to silent journal logs.
  expires_human="<unknown>"
  if [[ "$EXPIRES_MS" != "0" ]]; then
    expires_human=$(date -d "@$(( EXPIRES_MS / 1000 ))" -u "+%Y-%m-%d %H:%M:%S UTC" 2>/dev/null || echo "<unparseable>")
  fi
  notify_slack "$(printf '⚠️ EC2 creds refresh failed (HTTP %s, error=%s%s). EC2 token expires at %s. If you just ran /login on the Mac, run: bash /Users/<user>/Nexus/core/scripts/sync-claude-creds.sh --ec2-bootstrap' \
    "$HTTP" "$ERR" "${DESC:+, $DESC}" "$expires_human")"

  exit 5
fi

# Successful refresh — clear any stale backoff marker so subsequent
# ticks aren't gated.
if [[ -f "$BACKOFF_FILE" ]]; then
  rm -f "$BACKOFF_FILE"
  log "cleared backoff marker after successful refresh"
fi

if [[ "$(jq -r 'has("access_token") and (.access_token | tostring | length > 0)' "$RESP" 2>/dev/null)" != "true" ]]; then
  log "200 but response missing access_token; not overwriting creds"
  exit 6
fi

# Compose the new creds JSON, preserving fields the OAuth response doesn't
# carry (subscriptionType, rateLimitTier). refreshToken rotates if the
# server returns one, otherwise we keep the existing.
NEW_JSON=$(jq -n \
  --slurpfile cur "$CREDS_FILE" \
  --slurpfile resp "$RESP" \
  --argjson now_ms "$NOW_MS" \
  '
  ($cur[0]) as $c |
  ($resp[0]) as $r |
  $c + {
    claudeAiOauth: ($c.claudeAiOauth + {
      accessToken: $r.access_token,
      refreshToken: ($r.refresh_token // $c.claudeAiOauth.refreshToken)
    } + (
      if ($r.expires_at | type == "number")
        then { expiresAt: ($r.expires_at | tonumber) }
      elif ($r.expires_in | type == "number")
        then { expiresAt: ($now_ms + ($r.expires_in * 1000) | floor) }
      else {} end
    ) + (
      if $r.scope then { scopes: ($r.scope | split(" ")) } else {} end
    ))
  }
  ' 2>/dev/null) || NEW_JSON=""

if [[ -z "$NEW_JSON" || "$NEW_JSON" == "null" ]]; then
  log "failed to compose new creds JSON"
  exit 7
fi

# Atomic in-place write. tmp file in the same dir guarantees rename(2) is
# atomic. Backup the previous file first so a same-second crash leaves a
# recoverable state.
TMP=$(mktemp "${CREDS_FILE}.XXXXXX")
chmod 600 "$TMP"
printf '%s' "$NEW_JSON" > "$TMP"

cp -p "$CREDS_FILE" "${CREDS_FILE}.bak"
mv -f "$TMP" "$CREDS_FILE"
chmod 600 "$CREDS_FILE"

NEW_EXP_MS=$(jq -r '.claudeAiOauth.expiresAt // 0' "$CREDS_FILE" 2>/dev/null || echo 0)
NEW_DELTA_MIN=$(( (NEW_EXP_MS - NOW_MS) / 60000 ))
log "ok: refreshed; new expiresAt=${NEW_EXP_MS} (in ${NEW_DELTA_MIN}min)"

# Replicate refreshed file to the ubuntu copy used by forge-console.
mirror_creds

exit 0
