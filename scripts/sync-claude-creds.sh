#!/usr/bin/env bash
#
# sync-claude-creds.sh — LEGACY bootstrap utility for Claude Code credentials.
#
# *** CANONICAL DIRECTION FLIPPED 2026-05-03 ***
#
# EC2 is now the source of truth. Its systemd timer
# (scripts/forge/claude-creds-refresh.{sh,service,timer}) owns the OAuth
# refresh chain 24/7, and the Mac trails EC2 via
# scripts/pull-claude-creds-from-ec2.sh + ai.[company].claude-creds-pull.plist.
#
# Why the flip: Anthropic's OAuth almost certainly rotates refresh_tokens
# (RFC 6819 / OAuth 2.1 BCP for public clients). If both Mac and EC2
# refreshed independently they would invalidate each other's chain. EC2
# is awake 24/7 so it must be the refresher; Mac mirrors it.
#
# What this script is for now:
#   1. Initial bootstrap — running fresh `claude auth login` on the Mac
#      and seeding EC2 from the resulting Keychain entry.
#   2. Recovery — when EC2's refresh chain is broken (instance rebuilt,
#      curl outages exceeded the 8h token TTL, etc) and you need to
#      reseed EC2 from the Mac's currently-valid Keychain.
#
# *** DO NOT SCHEDULE THIS SCRIPT VIA LAUNCHD. *** The auto-sync direction
# is now Mac ← EC2, handled by ai.[company].claude-creds-pull.plist.
#
# Default behavior (no flags):
#   - If access token has <2h life: silent OAuth refresh against
#     platform.claude.com/v1/oauth/token, write back to Keychain.
#     (Note: this can compete with EC2's refresh — only run on demand.)
#   - Push the refreshed accessToken to GitHub Actions secret
#     CLAUDE_CODE_OAUTH_TOKEN if `gh` is installed.
#   - Do NOT touch EC2.
#
# Usage:
#   sync-claude-creds.sh                   # Mac Keychain refresh + GH secret
#   sync-claude-creds.sh --force           # also push GH secret unconditionally
#   sync-claude-creds.sh --ec2-bootstrap   # ALSO SCP to EC2 (instance rebuild)

set -euo pipefail

# ---------- Configuration ----------
EC2_HOST="[redacted-host]"
EC2_USER="root"
REMOTE_DIR="/root/.claude"
REMOTE_PATH="${REMOTE_DIR}/.credentials.json"
KEYCHAIN_SERVICE="Claude Code-credentials"
FRESH_THRESHOLD_DAYS=30

# Silent OAuth refresh — when the access token has less than this many
# milliseconds of life remaining, attempt a refresh-token grant against
# Anthropic's OAuth endpoint BEFORE syncing to EC2. The refresh result is
# written back to the Mac Keychain so the next user of the local `claude`
# CLI doesn't get re-prompted for /login. 2 hours gives plenty of margin
# for an 8h access-token lifetime — refresh kicks in well before any
# downstream consumer (forge-worker, GitHub Actions) would 401.
REFRESH_THRESHOLD_MS=$(( 2 * 60 * 60 * 1000 ))

# Anthropic OAuth token endpoint + Claude Code's published client_id.
# Discovered by `strings(1)`-grepping the claude binary at
# `~/.local/share/claude/versions/<v>/...`. The /v1/oauth/token path is
# published, the client_id is hardcoded in the binary (it's a public
# OAuth client identifier — not a secret).
OAUTH_TOKEN_URL="https://platform.claude.com/v1/oauth/token"
OAUTH_CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"

# ---------- Colors ----------
if [ -t 1 ]; then
  GREEN="$(printf '\033[0;32m')"
  RED="$(printf '\033[0;31m')"
  YELLOW="$(printf '\033[0;33m')"
  BOLD="$(printf '\033[1m')"
  RESET="$(printf '\033[0m')"
else
  GREEN=""; RED=""; YELLOW=""; BOLD=""; RESET=""
fi

info()    { printf "%s[INFO]%s %s\n" "$YELLOW" "$RESET" "$*"; }
success() { printf "%s[OK]%s   %s\n" "$GREEN"  "$RESET" "$*"; }
error()   { printf "%s[ERR]%s  %s\n" "$RED"    "$RESET" "$*" >&2; }

# ---------- GitHub Actions secret push ----------
# Mirrors the keychain's accessToken into the CLAUDE_CODE_OAUTH_TOKEN repo
# secret so claude-review (and any other GH Actions workflow that needs to
# call the Anthropic API) keeps working without a manual rotation.
#
# Gated on `gh` AND `jq` being present so this is a clean no-op on hosts
# without either — the EC2 sync leg always runs regardless.
# Failures here NEVER propagate: a missing gh token, a 5xx from GitHub,
# anything — log and return 0 so the EC2 leg isn't held hostage.
push_to_github_secret() {
  if ! command -v gh >/dev/null 2>&1; then
    info "gh CLI not available — skipping GitHub Actions secret push"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    info "jq not available — skipping GitHub Actions secret push (need jq to extract accessToken)"
    return 0
  fi

  local token=""
  token=$(printf '%s' "$CRED_JSON" | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null) || token=""
  if [ -z "$token" ] || [ "$token" = "null" ]; then
    error "claudeAiOauth.accessToken not found in keychain JSON — skipping GitHub secret push"
    return 0
  fi

  if gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo [org]/Nexus --body "$token" >/dev/null 2>&1; then
    success "GitHub secret CLAUDE_CODE_OAUTH_TOKEN updated on [org]/Nexus"
  else
    error "gh secret set failed — GitHub Actions runs may 401 until next successful sync (EC2 leg already done)"
  fi
  return 0
}

# ---------- Arg parsing ----------
FORCE=0
EC2_BOOTSTRAP=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --ec2-bootstrap) EC2_BOOTSTRAP=1 ;;
    -h|--help)
      /usr/bin/sed -n '2,/^$/p' "$0" | /usr/bin/sed -E 's/^# ?//'
      exit 0
      ;;
    *)
      error "Unknown argument: $arg"
      error "Usage: $0 [--force] [--ec2-bootstrap]"
      exit 1
      ;;
  esac
done

# ---------- Extract credentials from macOS Keychain ----------
info "Reading credentials from macOS Keychain (service: '${KEYCHAIN_SERVICE}')..."
CRED_JSON=$(/usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
  error "Keychain entry '${KEYCHAIN_SERVICE}' not found."
  error "Run 'claude auth login' on this Mac first, then retry."
  exit 1
}
if [ -z "$CRED_JSON" ]; then
  error "Keychain returned empty credentials."
  exit 1
fi
success "Credentials extracted from keychain"

# ---------- Parse expiresAt (milliseconds since epoch) ----------
# Prefer jq when available; otherwise fall back to python3. Both walk the
# JSON recursively so we catch expiresAt regardless of nesting depth.
parse_expires_ms() {
  local json="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r '.. | objects | .expiresAt? // empty' | head -n1
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c '
import json, sys
def find(o):
    if isinstance(o, dict):
        if "expiresAt" in o:
            return o["expiresAt"]
        for v in o.values():
            r = find(v)
            if r is not None:
                return r
    elif isinstance(o, list):
        for v in o:
            r = find(v)
            if r is not None:
                return r
    return None
try:
    j = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = find(j)
if v is not None:
    print(v)
'
  else
    return 1
  fi
}

EXPIRES_MS=$(parse_expires_ms "$CRED_JSON" || true)
if [ -z "$EXPIRES_MS" ] || ! [[ "$EXPIRES_MS" =~ ^[0-9]+$ ]]; then
  error "Could not parse expiresAt from credentials JSON (got: '${EXPIRES_MS:-<empty>}')"
  error "Neither jq nor python3 available, or JSON has no expiresAt field."
  exit 1
fi

NOW_MS=$(( $(date +%s) * 1000 ))
DELTA_MS=$(( EXPIRES_MS - NOW_MS ))
DAYS_LEFT=$(( DELTA_MS / 86400000 ))
EXPIRES_S=$(( EXPIRES_MS / 1000 ))

# macOS date: -r takes a unix timestamp (seconds).
EXPIRES_HUMAN=$(date -r "$EXPIRES_S" 2>/dev/null || echo "<unparseable>")

info "Token expires at: ${BOLD}${EXPIRES_HUMAN}${RESET} (${DAYS_LEFT} days from now)"

# ---------- Silent OAuth refresh (best-effort) ----------
# Attempts a refresh-token grant when the access token is near expiry.
# Never prints token values. On any failure, falls back to syncing the
# existing (possibly-near-expired) token so the EC2 leg keeps working.
#
# Updates CRED_JSON, EXPIRES_MS, EXPIRES_HUMAN in place on success so
# the downstream sync uses the fresh values.
attempt_oauth_refresh() {
  if ! command -v jq >/dev/null 2>&1; then
    info "jq not available — skipping OAuth refresh (sync will proceed with existing token)"
    return 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    info "curl not available — skipping OAuth refresh"
    return 1
  fi

  local refresh_token
  refresh_token=$(printf '%s' "$CRED_JSON" | jq -r '.claudeAiOauth.refreshToken // empty' 2>/dev/null) || refresh_token=""
  if [ -z "$refresh_token" ] || [ "$refresh_token" = "null" ]; then
    error "claudeAiOauth.refreshToken not present in keychain — cannot refresh"
    return 1
  fi

  # Capture response to a 600-perms tmpfile. Body contains tokens; never
  # echo or log it. We extract structural info via jq for diagnostics.
  local resp_file http_code
  resp_file=$(mktemp /tmp/.claude-refresh-resp.XXXXXX)
  chmod 600 "$resp_file"

  http_code=$(curl --silent --max-time 15 \
    --output "$resp_file" \
    --write-out "%{http_code}" \
    -X POST "$OAUTH_TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Accept: application/json" \
    --data-urlencode "grant_type=refresh_token" \
    --data-urlencode "refresh_token=${refresh_token}" \
    --data-urlencode "client_id=${OAUTH_CLIENT_ID}" 2>/dev/null) || http_code="000"

  if [ "$http_code" != "200" ]; then
    # Extract just the error code/message from the response — jq pulls
    # only the documented error fields, so token-bearing fields never
    # land in our log even if the response shape drifts.
    local err_kind err_desc
    err_kind=$(jq -r '.error // .type // "unknown"' < "$resp_file" 2>/dev/null || echo "unparseable")
    err_desc=$(jq -r '.error_description // .message // ""' < "$resp_file" 2>/dev/null || echo "")
    error "OAuth refresh returned HTTP ${http_code} (error=${err_kind}${err_desc:+; ${err_desc}})"
    rm -f "$resp_file"
    return 1
  fi

  local has_access
  has_access=$(jq -r 'has("access_token") and (.access_token | tostring | length > 0)' < "$resp_file" 2>/dev/null) || has_access="false"
  if [ "$has_access" != "true" ]; then
    error "OAuth refresh succeeded (HTTP 200) but response is missing access_token — refusing to overwrite Keychain"
    rm -f "$resp_file"
    return 1
  fi

  # Compose the updated claudeAiOauth blob:
  #   - accessToken: from response.
  #   - refreshToken: rotates if response includes a new one, else preserve.
  #   - expiresAt: prefer response.expires_at (ms) if present; otherwise
  #     derive from now + (response.expires_in seconds * 1000).
  #   - scopes/subscriptionType/rateLimitTier: preserve existing values.
  local new_cred_json
  new_cred_json=$(jq -n \
    --argjson old "$CRED_JSON" \
    --slurpfile resp "$resp_file" \
    --argjson now_ms "$NOW_MS" \
    '
    ($resp[0]) as $r |
    {
      claudeAiOauth: (
        $old.claudeAiOauth + {
          accessToken: $r.access_token,
          refreshToken: ($r.refresh_token // $old.claudeAiOauth.refreshToken)
        } + (
          if ($r.expires_at | type == "number")
          then { expiresAt: ($r.expires_at | tonumber) }
          elif ($r.expires_in | type == "number")
          then { expiresAt: ($now_ms + ($r.expires_in * 1000) | floor) }
          else {}
          end
        ) + (
          if $r.scope then { scopes: ($r.scope | split(" ")) } else {} end
        )
      )
    }
    ' 2>/dev/null) || new_cred_json=""
  rm -f "$resp_file"

  if [ -z "$new_cred_json" ] || [ "$new_cred_json" = "null" ]; then
    error "Failed to compose updated credentials JSON from refresh response"
    return 1
  fi

  # Persist back to Keychain. -U updates the existing entry matched by
  # service+account (USER). Note: the JSON is briefly visible in `ps`
  # while `security` runs (a few ms). On a single-user Mac that's
  # acceptable; if multi-user, this script shouldn't run there anyway.
  if /usr/bin/security add-generic-password \
       -U \
       -s "$KEYCHAIN_SERVICE" \
       -a "${USER:-$LOGNAME}" \
       -w "$new_cred_json" >/dev/null 2>&1; then
    success "Refreshed Keychain credentials via OAuth refresh-token grant"
  else
    error "security add-generic-password failed; Keychain not updated. Sync will proceed with old token."
    return 1
  fi

  # Re-derive in-memory expiry markers so the downstream freshness check
  # and sync see the new values.
  CRED_JSON="$new_cred_json"
  local new_expires_ms
  new_expires_ms=$(printf '%s' "$CRED_JSON" | jq -r '.claudeAiOauth.expiresAt // empty' 2>/dev/null) || new_expires_ms=""
  if [[ "$new_expires_ms" =~ ^[0-9]+$ ]]; then
    EXPIRES_MS="$new_expires_ms"
    DELTA_MS=$(( EXPIRES_MS - NOW_MS ))
    DAYS_LEFT=$(( DELTA_MS / 86400000 ))
    EXPIRES_S=$(( EXPIRES_MS / 1000 ))
    EXPIRES_HUMAN=$(date -r "$EXPIRES_S" 2>/dev/null || echo "<unparseable>")
    info "Refreshed token expires at: ${BOLD}${EXPIRES_HUMAN}${RESET}"
  fi
  return 0
}

if [ "$DELTA_MS" -lt "$REFRESH_THRESHOLD_MS" ]; then
  info "Token has < 2h remaining (delta=${DELTA_MS}ms) — attempting silent OAuth refresh"
  attempt_oauth_refresh || info "Refresh did not complete; continuing with existing token"
fi

# ---------- EC2 bootstrap (opt-in only) ----------
# As of 2026-05-03, EC2 self-refreshes via systemd timer. Default skip;
# only run when explicitly asked, e.g. after rebuilding the EC2 instance
# or if EC2's refresh chain is somehow broken and you want to reseed.
if [ "$EC2_BOOTSTRAP" -eq 1 ]; then
  info "EC2 bootstrap mode — uploading current Keychain creds to EC2 (will clobber EC2's chain!)"

  TMP_FILE=$(mktemp /tmp/.claude-creds.XXXXXX)
  trap 'rm -f "$TMP_FILE"' EXIT INT TERM
  chmod 600 "$TMP_FILE"
  printf '%s' "$CRED_JSON" > "$TMP_FILE"

  info "Ensuring remote ${REMOTE_DIR} exists"
  ssh -i ~/.ssh/nexus-forge-worker-key.pem "${EC2_USER}@${EC2_HOST}" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'"

  info "Uploading credentials to ${EC2_USER}@${EC2_HOST}:${REMOTE_PATH}"
  scp -q -i ~/.ssh/nexus-forge-worker-key.pem "$TMP_FILE" "${EC2_USER}@${EC2_HOST}:${REMOTE_PATH}"
  success "Upload complete"

  info "Setting remote permissions to 600"
  ssh -i ~/.ssh/nexus-forge-worker-key.pem "${EC2_USER}@${EC2_HOST}" "chmod 600 '${REMOTE_PATH}'"
  success "Permissions set"
else
  info "EC2 leg skipped (default — EC2 self-refreshes via systemd timer). Pass --ec2-bootstrap to force."
fi

# ---------- Push refreshed accessToken to GH Actions secret ----------
# Always-on (no-op when gh missing). Independent of the EC2 leg.
push_to_github_secret

printf "\n%s==> Sync complete%s\n" "$BOLD" "$RESET"
info "Token valid until: ${BOLD}${EXPIRES_HUMAN}${RESET} (${DAYS_LEFT} days)"

exit 0
