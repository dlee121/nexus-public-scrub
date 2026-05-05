#!/usr/bin/env bash
#
# forge-secrets-fetch.sh — pull forge-worker secrets from AWS Secrets Manager
# and write them to /run/forge-worker.env (tmpfs, non-persistent) before the
# forge-console / forge-worker systemd services start.
#
# This script is invoked by `forge-secrets.service` (oneshot). Both
# forge-console.service and forge-worker.service order themselves
# `After=forge-secrets.service` + `Requires=forge-secrets.service`, so a
# successful run is the precondition for either service starting.
#
# What it does NOT touch: Claude OAuth credentials at
# /root/.claude/.credentials.json. Those continue to be managed by the
# launchd-driven sync-claude-creds.sh push from the operator's Mac.
#
# === Convention ===
#
# Every secret in AWS SM is named:
#
#   /forge-worker/${FORGE_SECRETS_ENV:-prod}/<KEY>
#
# Where <KEY> is exactly the env var name to project. So:
#
#   /forge-worker/prod/GITHUB_TOKEN  → GITHUB_TOKEN=<value>
#
# The script enumerates every secret under the prefix, fetches each
# value, and writes a `KEY=value` line for it.
#
# Two keys get special-cased because the consumer expects a file path,
# not a string. The cert content is written to a tmpfs file, but the
# path env var is NOT set here — the consuming service unit chooses the
# path via Environment=TEMPORAL_TLS_*_PATH=...:
#
#   TEMPORAL_TLS_CERT  → /run/forge-worker/temporal-tls.crt
#   TEMPORAL_TLS_KEY   → /run/forge-worker/temporal-tls.key
#
# === Modes ===
#
#   FORGE_SECRETS_MODE=strict (default)
#     Any SM failure (network, IAM, no secrets at prefix, missing required
#     env var) → exit non-zero. systemd refuses to start the service. This
#     is the secure default; production runs with this.
#
#   FORGE_SECRETS_MODE=soft
#     If SM is unreachable AND /run/forge-worker.env already exists, leave
#     it in place, log a warning to journal, and exit 0. Use only during
#     cutover so a botched IAM doesn't take down a working host. Set via
#     `Environment=FORGE_SECRETS_MODE=soft` in the service unit.
#
# === Required tools on the host ===
#
#   - aws (AWS CLI v2)
#   - jq
#
# Both available in the bookworm-slim Docker image used for the worker;
# also available on the Ubuntu host that runs forge-console.

set -euo pipefail

# ---------- Config ----------------------------------------------------------

ENV_NAME="${FORGE_SECRETS_ENV:-prod}"
SM_PREFIX="/forge-worker/${ENV_NAME}"
AWS_REGION="${AWS_REGION:-us-west-2}"
MODE="${FORGE_SECRETS_MODE:-strict}"

# /run is a tmpfs — env file vanishes on reboot, has to be re-fetched.
# That's the point: secrets never persist on disk.
ENV_FILE="/run/forge-worker.env"
RUNTIME_DIR="/run/forge-worker"
TLS_CERT_PATH="${RUNTIME_DIR}/temporal-tls.crt"
TLS_KEY_PATH="${RUNTIME_DIR}/temporal-tls.key"

# ---------- Logging ---------------------------------------------------------

log()  { printf '[forge-secrets] %s\n' "$*" >&2; }
die()  { log "FATAL: $*"; exit 1; }
warn() { log "WARN:  $*"; }

# ---------- Mode helpers ----------------------------------------------------

# Soft-mode escape hatch: if MODE=soft and an existing env file is in place,
# treat any SM failure as a no-op and exit 0 so systemd starts the service
# with the previous (probably-good) values. Strict mode always aborts.
soft_abort_if_env_exists() {
  local reason="$1"
  if [ "$MODE" = "soft" ] && [ -s "$ENV_FILE" ]; then
    warn "SM failed ($reason) but MODE=soft and $ENV_FILE exists — leaving as-is."
    exit 0
  fi
  die "$reason"
}

# ---------- Preflight -------------------------------------------------------

command -v aws >/dev/null 2>&1 || die "aws CLI not on PATH (install awscli v2)"
command -v jq  >/dev/null 2>&1 || die "jq not on PATH (apt-get install -y jq)"

log "fetching secrets under ${SM_PREFIX} (region=${AWS_REGION}, mode=${MODE})"

# ---------- List every secret under the prefix -----------------------------
#
# `secretsmanager list-secrets` paginates at 100; loop until NextToken is
# empty so we don't silently truncate the secret set.

declare -a SECRET_NAMES=()
NEXT_TOKEN=""
while :; do
  if [ -n "$NEXT_TOKEN" ]; then
    PAGE=$(aws secretsmanager list-secrets \
      --region "$AWS_REGION" \
      --filters "Key=name,Values=${SM_PREFIX}/" \
      --max-results 100 \
      --next-token "$NEXT_TOKEN" \
      --output json 2>&1) || soft_abort_if_env_exists "list-secrets failed: $PAGE"
  else
    PAGE=$(aws secretsmanager list-secrets \
      --region "$AWS_REGION" \
      --filters "Key=name,Values=${SM_PREFIX}/" \
      --max-results 100 \
      --output json 2>&1) || soft_abort_if_env_exists "list-secrets failed: $PAGE"
  fi

  while IFS= read -r name; do
    [ -n "$name" ] && SECRET_NAMES+=("$name")
  done < <(printf '%s' "$PAGE" | jq -r '.SecretList[].Name')

  NEXT_TOKEN=$(printf '%s' "$PAGE" | jq -r '.NextToken // empty')
  [ -z "$NEXT_TOKEN" ] && break
done

if [ ${#SECRET_NAMES[@]} -eq 0 ]; then
  soft_abort_if_env_exists "no secrets found under ${SM_PREFIX}/"
fi

log "found ${#SECRET_NAMES[@]} secret(s) under prefix"

# ---------- Stage to a tempfile, then atomic rename ------------------------
#
# Atomic rename means: a half-written env file is never observable. If the
# script crashes mid-fetch, the previous env file remains.

TMP_ENV=$(mktemp /run/forge-worker.env.XXXXXX)
chmod 0600 "$TMP_ENV"
trap 'rm -f "$TMP_ENV"' EXIT

mkdir -p "$RUNTIME_DIR"
chmod 0700 "$RUNTIME_DIR"

# Header so anyone catting the file knows where it came from.
{
  printf '# Forge worker secrets — fetched from AWS Secrets Manager\n'
  printf '# Source: %s/* (region=%s)\n' "$SM_PREFIX" "$AWS_REGION"
  printf '# Generated: %s by forge-secrets-fetch.sh\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '# Do NOT edit by hand — this file is regenerated on every service restart.\n'
} > "$TMP_ENV"

# ---------- Fetch each secret and project to env --------------------------

PROJECTED=0
for name in "${SECRET_NAMES[@]}"; do
  # KEY is the trailing path segment after the prefix. e.g.
  # /forge-worker/prod/GITHUB_TOKEN → GITHUB_TOKEN
  KEY="${name##*/}"

  # Sanity: env var names must be [A-Z_][A-Z0-9_]*. Reject anything else
  # so a typo'd SM secret (lowercase, dash, etc.) doesn't quietly produce
  # a dud line in the env file.
  if ! [[ "$KEY" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    warn "skipping malformed secret key: $name"
    continue
  fi

  VALUE=$(aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$name" \
    --query 'SecretString' \
    --output text 2>&1) || soft_abort_if_env_exists "get-secret-value failed for $name: $VALUE"

  case "$KEY" in
    TEMPORAL_TLS_CERT)
      # Write the cert file but do NOT emit TEMPORAL_TLS_CERT_PATH into the
      # env file. The path is set by the consuming service unit's Environment=
      # directive instead — this lets operators point the worker at a
      # different cert location (e.g. /opt/nexus/core/certs/) without having
      # to re-populate SM. When SM is the canonical cert source, set
      # TEMPORAL_TLS_CERT_PATH=/run/forge-worker/temporal-tls.crt in the unit.
      printf '%s' "$VALUE" > "$TLS_CERT_PATH"
      chmod 0444 "$TLS_CERT_PATH"
      log "  TEMPORAL_TLS_CERT → $TLS_CERT_PATH (path NOT exported; set TEMPORAL_TLS_CERT_PATH in the unit)"
      ;;
    TEMPORAL_TLS_KEY)
      # See TEMPORAL_TLS_CERT case above for the rationale.
      printf '%s' "$VALUE" > "$TLS_KEY_PATH"
      chmod 0400 "$TLS_KEY_PATH"
      log "  TEMPORAL_TLS_KEY → $TLS_KEY_PATH (path NOT exported; set TEMPORAL_TLS_KEY_PATH in the unit)"
      ;;
    *)
      # systemd EnvironmentFile cannot hold multi-line values — every entry
      # must be a complete `KEY=value` on a single line. A real newline in
      # the value would silently break the parser (truncated value, next
      # line interpreted as a new entry). Reject up front with a clear
      # message; the operator should either use the TLS-style file-path
      # convention (write secret to a file, project the path) or
      # base64-encode the value before storing in SM.
      case "$VALUE" in
        *$'\n'*)
          die "secret $name has a newline in its value, which systemd EnvironmentFile cannot represent — store as base64 in SM and decode in the consumer, or use a file-path convention like TEMPORAL_TLS_CERT"
          ;;
      esac
      # Quote the value so a literal space / # / quote doesn't break the
      # parser. systemd's EnvironmentFile parsing is roughly POSIX
      # shell-style: "..." preserves the inner content verbatim except
      # for backslash-escapes. Escape backslashes first, then double
      # quotes — order matters (double-escaping a backslash that
      # precedes a quote would otherwise yield wrong output).
      ESCAPED=${VALUE//\\/\\\\}
      ESCAPED=${ESCAPED//\"/\\\"}
      printf '%s="%s"\n' "$KEY" "$ESCAPED" >> "$TMP_ENV"
      log "  $KEY → set"
      ;;
  esac

  PROJECTED=$((PROJECTED + 1))
done

if [ "$PROJECTED" -eq 0 ]; then
  soft_abort_if_env_exists "every secret under ${SM_PREFIX}/ had a malformed key"
fi

# ---------- Atomic publish -------------------------------------------------

mv -f "$TMP_ENV" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
trap - EXIT  # tmpfile is now the real env file — don't unlink on exit

log "wrote $PROJECTED env entries to $ENV_FILE"
exit 0
