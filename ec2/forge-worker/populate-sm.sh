#!/usr/bin/env bash
#
# populate-sm.sh — bootstrap AWS Secrets Manager from an existing
# /run/forge-worker.env file. Run ONCE during the initial migration.
#
# Reads a `KEY=value` env file (default: /run/forge-worker.env) and creates
# (or updates) one SM secret per line at:
#
#   /forge-worker/${FORGE_SECRETS_ENV:-prod}/<KEY>
#
# Two special-cased keys read their value from the FILE referenced by
# *_PATH env vars rather than the env value itself, so the cert/key
# contents land in SM:
#
#   TEMPORAL_TLS_CERT_PATH → SM key `TEMPORAL_TLS_CERT`  (PEM contents)
#   TEMPORAL_TLS_KEY_PATH  → SM key `TEMPORAL_TLS_KEY`   (PEM contents)
#
# Skips two classes of vars:
#   1. Anything matching the SKIP_PATTERNS list below — these are config,
#      not secrets, and don't belong in SM.
#   2. Empty values.
#
# Run with --dry-run first to preview what gets created.
#
# Usage:
#   sudo bash populate-sm.sh --dry-run
#   sudo bash populate-sm.sh                     # interactive confirm per secret
#   sudo bash populate-sm.sh --yes               # non-interactive, overwrite all
#   sudo bash populate-sm.sh --env-file /path/to/file --yes

set -euo pipefail

ENV_NAME="${FORGE_SECRETS_ENV:-prod}"
SM_PREFIX="/forge-worker/${ENV_NAME}"
AWS_REGION="${AWS_REGION:-us-west-2}"

ENV_FILE="/run/forge-worker.env"
DRY_RUN=0
ASSUME_YES=0

# Names that should NEVER go into SM — they're plain config or
# script-managed paths.
SKIP_PATTERNS=(
  "FORGE_CONSOLE_HOST"
  "FORGE_CONSOLE_PORT"
  "FORGE_CONSOLE_URL"
  "FORGE_DEPLOY_CHECKOUT_BASE"
  "FORGE_WORKTREE_BASE"
  "TEMPORAL_ADDRESS"
  "TEMPORAL_NAMESPACE"
  "NEXUS_CORE_PATH"
  "AWS_REGION"
  "LINEAR_TEAM_ID"
  "FORGE_SECRETS_MODE"
  "FORGE_SECRETS_ENV"
)

# ---------- Args ----------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1; shift ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    --env-file)  ENV_FILE="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------- Helpers ------------------------------------------------------

log()  { printf '[populate-sm] %s\n' "$*" >&2; }
die()  { log "FATAL: $*"; exit 1; }

is_skipped() {
  local key="$1"
  for pat in "${SKIP_PATTERNS[@]}"; do
    [ "$key" = "$pat" ] && return 0
  done
  return 1
}

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '  → %s? [y/N] ' "$1" >&2
  read -r answer
  [[ "$answer" =~ ^[Yy] ]]
}

# Create-or-update a secret. SM has separate APIs for create vs update; we
# try create first and fall through to put-secret-value on AlreadyExists.
upsert_secret() {
  local sm_name="$1" sm_value="$2"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY: would upsert $sm_name (${#sm_value} bytes)"
    return 0
  fi

  if aws secretsmanager describe-secret \
        --region "$AWS_REGION" \
        --secret-id "$sm_name" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --region "$AWS_REGION" \
      --secret-id "$sm_name" \
      --secret-string "$sm_value" >/dev/null
    log "  updated $sm_name"
  else
    aws secretsmanager create-secret \
      --region "$AWS_REGION" \
      --name "$sm_name" \
      --secret-string "$sm_value" >/dev/null
    log "  created $sm_name"
  fi
}

# ---------- Preflight ----------------------------------------------------

command -v aws >/dev/null 2>&1 || die "aws CLI not on PATH"
[ -r "$ENV_FILE" ] || die "env file not readable: $ENV_FILE"

log "source: $ENV_FILE"
log "target: ${SM_PREFIX}/* (region=${AWS_REGION})"
[ "$DRY_RUN" -eq 1 ] && log "DRY RUN — no SM writes will happen"
echo >&2

# ---------- Walk env file ------------------------------------------------

CREATED=0
SKIPPED=0
SPECIAL_TLS_CERT_DONE=0
SPECIAL_TLS_KEY_DONE=0

while IFS= read -r line || [ -n "$line" ]; do
  # Strip comments + blank lines
  case "$line" in ''|\#*) continue ;; esac
  # KEY=VALUE — split on the first =. Tolerate quoted values.
  KEY="${line%%=*}"
  VAL="${line#*=}"
  # Strip surrounding double-quotes if present
  if [[ "$VAL" =~ ^\".*\"$ ]]; then
    VAL="${VAL:1:${#VAL}-2}"
    # Reverse the script's escape (\\ → \, \" → ")
    VAL=${VAL//\\\"/\"}
    VAL=${VAL//\\\\/\\}
  fi

  # Skip non-secret config keys
  if is_skipped "$KEY"; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Empty values mean unset — nothing to upsert
  [ -z "$VAL" ] && { SKIPPED=$((SKIPPED + 1)); continue; }

  # Special-case the TLS PATHs — read the file contents and store as the
  # PEM-content secret. Don't store the path itself in SM.
  case "$KEY" in
    TEMPORAL_TLS_CERT_PATH)
      [ -r "$VAL" ] || die "TEMPORAL_TLS_CERT_PATH points to unreadable file: $VAL"
      log "TEMPORAL_TLS_CERT_PATH → reading PEM from $VAL"
      if confirm "upsert TEMPORAL_TLS_CERT (cert from $VAL)"; then
        upsert_secret "${SM_PREFIX}/TEMPORAL_TLS_CERT" "$(cat "$VAL")"
        SPECIAL_TLS_CERT_DONE=1
        CREATED=$((CREATED + 1))
      fi
      continue
      ;;
    TEMPORAL_TLS_KEY_PATH)
      [ -r "$VAL" ] || die "TEMPORAL_TLS_KEY_PATH points to unreadable file: $VAL"
      log "TEMPORAL_TLS_KEY_PATH → reading PEM from $VAL"
      if confirm "upsert TEMPORAL_TLS_KEY (key from $VAL)"; then
        upsert_secret "${SM_PREFIX}/TEMPORAL_TLS_KEY" "$(cat "$VAL")"
        SPECIAL_TLS_KEY_DONE=1
        CREATED=$((CREATED + 1))
      fi
      continue
      ;;
  esac

  # Normal secret
  log "$KEY (${#VAL} bytes)"
  if confirm "upsert $KEY"; then
    upsert_secret "${SM_PREFIX}/${KEY}" "$VAL"
    CREATED=$((CREATED + 1))
  fi
done < "$ENV_FILE"

echo >&2
log "summary: $CREATED upserted, $SKIPPED skipped (config/empty)"

# Sanity check: cert + key are both required for Temporal mTLS. Warn if
# only one made it in — the prestart will fail strict mode otherwise.
if [ "$SPECIAL_TLS_CERT_DONE" -eq 1 ] && [ "$SPECIAL_TLS_KEY_DONE" -eq 0 ]; then
  log "WARN: TEMPORAL_TLS_CERT was upserted but TEMPORAL_TLS_KEY was not — Temporal mTLS will fail."
fi
if [ "$SPECIAL_TLS_KEY_DONE" -eq 1 ] && [ "$SPECIAL_TLS_CERT_DONE" -eq 0 ]; then
  log "WARN: TEMPORAL_TLS_KEY was upserted but TEMPORAL_TLS_CERT was not — Temporal mTLS will fail."
fi
