#!/usr/bin/env bash
#
# pull-claude-creds-from-ec2.sh — pull Claude Code OAuth credentials from
# the EC2 forge-worker (canonical source) and write them into the Mac
# Keychain.
#
# Architecture (as of 2026-05-03):
#   EC2 is the canonical refresh authority. A systemd timer
#   (claude-creds-refresh.timer) runs there 24/7 and exchanges the
#   refresh_token at platform.claude.com/v1/oauth/token whenever the
#   access_token has <4h life remaining. Because Anthropic's OAuth almost
#   certainly rotates refresh_tokens (RFC 6819 / OAuth 2.1 BCP for public
#   clients), the Mac MUST trail EC2's refresh chain to avoid getting its
#   refresh_token invalidated.
#
#   This script fetches EC2's current credentials.json and writes it into
#   Mac Keychain (service "Claude Code-credentials"). It is invoked by
#   ~/Library/LaunchAgents/ai.[company].claude-creds-pull.plist on a 30-min
#   schedule + on every launchd load (login, manual reload, system wake
#   coalesces missed firings).
#
# Behavior:
#   - SCP /root/.claude/.credentials.json from EC2 to a tmpfile.
#   - Validate it parses as JSON and has the expected structure.
#   - If identical to current Keychain content, no-op.
#   - Else write to Keychain via `security add-generic-password -U`.
#   - Push the new accessToken to GH Actions secret CLAUDE_CODE_OAUTH_TOKEN
#     when `gh` is available (continues old behavior).
#
# Failure semantics:
#   - SSH/SCP failures: log + exit non-zero. Keychain unchanged.
#   - JSON validation failures: log + exit non-zero. Keychain unchanged.
#   - Keychain write failure: log + exit non-zero.
#   - GH secret push failure: log + continue (Keychain already updated).
#
# Usage:
#   pull-claude-creds-from-ec2.sh             # pull only when EC2 differs from Keychain
#   pull-claude-creds-from-ec2.sh --force     # always rewrite Keychain + push GH secret

set -euo pipefail

EC2_HOST="${EC2_HOST:-[redacted-host]}"
EC2_USER="${EC2_USER:-root}"
REMOTE_PATH="${REMOTE_PATH:-/root/.claude/.credentials.json}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/nexus-forge-worker-key.pem}"
KEYCHAIN_SERVICE="Claude Code-credentials"
GH_REPO="${GH_REPO:-[org]/Nexus}"

if [ -t 1 ]; then
  GREEN="$(printf '\033[0;32m')"; RED="$(printf '\033[0;31m')"; YELLOW="$(printf '\033[0;33m')"; RESET="$(printf '\033[0m')"
else
  GREEN=""; RED=""; YELLOW=""; RESET=""
fi
info()    { printf "%s[INFO]%s %s\n" "$YELLOW" "$RESET" "$*"; }
success() { printf "%s[OK]%s   %s\n" "$GREEN"  "$RESET" "$*"; }
error()   { printf "%s[ERR]%s  %s\n" "$RED"    "$RESET" "$*" >&2; }

FORCE=0
case "${1-}" in
  --force) FORCE=1 ;;
  ""|--help|-h)
    if [ "${1-}" = "-h" ] || [ "${1-}" = "--help" ]; then
      /usr/bin/sed -n '2,/^$/p' "$0" | /usr/bin/sed -E 's/^# ?//'
      exit 0
    fi
    ;;
  *)
    error "Unknown argument: $1"
    error "Usage: $0 [--force]"
    exit 2
    ;;
esac

# ---------- Pull from EC2 ----------
TMP_REMOTE=$(mktemp /tmp/.claude-creds-pull.XXXXXX)
trap 'rm -f "$TMP_REMOTE"' EXIT INT TERM
chmod 600 "$TMP_REMOTE"

info "Pulling ${EC2_USER}@${EC2_HOST}:${REMOTE_PATH} → tmpfile"
if ! scp -q -i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
     "${EC2_USER}@${EC2_HOST}:${REMOTE_PATH}" "$TMP_REMOTE"; then
  error "SCP from EC2 failed (key=${SSH_KEY}, host=${EC2_HOST})"
  exit 3
fi

if ! /usr/bin/jq -e '.claudeAiOauth.accessToken and .claudeAiOauth.refreshToken and .claudeAiOauth.expiresAt' \
     "$TMP_REMOTE" >/dev/null 2>&1; then
  error "Pulled file failed structural validation; refusing to write Keychain"
  exit 4
fi

REMOTE_EXPIRES_MS=$(/usr/bin/jq -r '.claudeAiOauth.expiresAt' "$TMP_REMOTE")
REMOTE_REFRESH_HASH=$(/usr/bin/jq -r '.claudeAiOauth.refreshToken' "$TMP_REMOTE" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print substr($1,1,16)}')

# ---------- Compare to current Keychain ----------
CURRENT_JSON=$(/usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)
if [ -n "$CURRENT_JSON" ]; then
  CURRENT_REFRESH_HASH=$(printf '%s' "$CURRENT_JSON" | /usr/bin/jq -r '.claudeAiOauth.refreshToken // empty' 2>/dev/null \
                        | /usr/bin/shasum -a 256 | /usr/bin/awk '{print substr($1,1,16)}')
  CURRENT_EXPIRES_MS=$(printf '%s' "$CURRENT_JSON" | /usr/bin/jq -r '.claudeAiOauth.expiresAt // 0' 2>/dev/null || echo 0)
else
  CURRENT_REFRESH_HASH=""
  CURRENT_EXPIRES_MS=0
fi

MATCHES=0
if [ "$REMOTE_REFRESH_HASH" = "$CURRENT_REFRESH_HASH" ] \
   && [ "$REMOTE_EXPIRES_MS" = "$CURRENT_EXPIRES_MS" ]; then
  MATCHES=1
fi

if [ "$FORCE" -ne 1 ] && [ "$MATCHES" -eq 1 ]; then
  info "Keychain already matches EC2 (refresh sha16=${REMOTE_REFRESH_HASH}, expiresAt=${REMOTE_EXPIRES_MS}); no-op"
  exit 0
fi

# Newer-Keychain guard: if local Keychain has a *later* expiresAt than
# EC2, the user almost certainly just did /login on the Mac (or otherwise
# refreshed locally) and we'd be clobbering a fresh chain with an older
# one. The previous behavior overwrote unconditionally on any diff, which
# caused a real outage today: launchd pull fired within 30 min of a fresh
# /login, saw the differing refreshToken, replaced fresh local creds with
# EC2's expired chain → 401 on the next Nexus session.
#
# --force still overrides this — explicit reseed from EC2 is sometimes
# what the operator wants (e.g. recovering from a corrupted Keychain).
if [ "$FORCE" -ne 1 ] \
   && [ "$CURRENT_EXPIRES_MS" -gt 0 ] \
   && [ "$CURRENT_EXPIRES_MS" -gt "$REMOTE_EXPIRES_MS" ]; then
  CUR_HUMAN=$(/bin/date -r $((CURRENT_EXPIRES_MS / 1000)) 2>/dev/null || echo "<unparseable>")
  REM_HUMAN=$(/bin/date -r $((REMOTE_EXPIRES_MS / 1000)) 2>/dev/null || echo "<unparseable>")
  error "Keychain is newer than EC2 (local expires ${CUR_HUMAN}, EC2 expires ${REM_HUMAN}) — skipping overwrite."
  error "If you just ran /login on the Mac, run scripts/sync-claude-creds.sh --ec2-bootstrap to re-seed EC2."
  error "To override and clobber Keychain anyway, re-run with --force."
  exit 0
fi

if [ "$MATCHES" -eq 1 ]; then
  info "Keychain matches EC2 but --force given; rewriting"
else
  info "Keychain differs from EC2 (Keychain refresh sha16=${CURRENT_REFRESH_HASH:-<empty>}, EC2 sha16=${REMOTE_REFRESH_HASH}); updating"
fi

# ---------- Write to Keychain ----------
NEW_JSON=$(cat "$TMP_REMOTE")
if /usr/bin/security add-generic-password \
     -U \
     -s "$KEYCHAIN_SERVICE" \
     -a "${USER:-$LOGNAME}" \
     -w "$NEW_JSON" >/dev/null 2>&1; then
  EXPIRES_HUMAN=$(/bin/date -r $((REMOTE_EXPIRES_MS / 1000)) 2>/dev/null || echo "<unparseable>")
  success "Keychain updated (token valid until ${EXPIRES_HUMAN})"
else
  error "security add-generic-password failed; Keychain unchanged"
  exit 5
fi

# ---------- Push accessToken to GH Actions secret ----------
push_to_github_secret() {
  if ! command -v gh >/dev/null 2>&1; then
    info "gh CLI not available; skipping GitHub Actions secret push"
    return 0
  fi
  local token
  token=$(/usr/bin/jq -r '.claudeAiOauth.accessToken // empty' "$TMP_REMOTE" 2>/dev/null)
  if [ -z "$token" ]; then
    error "accessToken missing from pulled JSON; skipping GH secret push"
    return 0
  fi
  if gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$GH_REPO" --body "$token" >/dev/null 2>&1; then
    success "GitHub secret CLAUDE_CODE_OAUTH_TOKEN updated on ${GH_REPO}"
  else
    error "gh secret set failed; GH Actions runs may 401 until next successful pull"
  fi
}
push_to_github_secret

exit 0
