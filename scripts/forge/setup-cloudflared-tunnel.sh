#!/usr/bin/env bash
#
# One-shot Forge cloudflared tunnel bring-up.
#
# Steps:
#   1. cloudflared tunnel login (interactive browser flow)
#   2. Create tunnel "forge" if it doesn't already exist
#   3. Resolve the tunnel UUID
#   4. SCP cert.pem + <UUID>.json to the EC2 host
#   5. SSH in and run /usr/local/sbin/forge-tunnel-finalize
#
# Override the EC2 host with FORGE_EC2_HOST (default: ec2-user@[redacted-host]).

set -euo pipefail

FORGE_EC2_HOST="${FORGE_EC2_HOST:-ec2-user@[redacted-host]}"
TUNNEL_NAME="forge"
CF_DIR="${HOME}/.cloudflared"

say() { printf '\n>>> %s\n' "$*"; }

# ── Preflight ────────────────────────────────────────────────────────────
for tool in cloudflared jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    case "$tool" in
      cloudflared) hint="brew install cloudflared" ;;
      jq)          hint="brew install jq" ;;
    esac
    echo "ERROR: '$tool' not found on PATH. Install with: $hint" >&2
    exit 1
  fi
done

say "Target EC2 host: ${FORGE_EC2_HOST}"

# ── Step 1: login ────────────────────────────────────────────────────────
# cloudflared tunnel login is idempotent — if cert.pem is already present
# and valid, it short-circuits. Safe to always call.
say "Step 1/5 — cloudflared tunnel login (browser flow)"
cloudflared tunnel login

# ── Step 2: create tunnel if missing ─────────────────────────────────────
say "Step 2/5 — ensuring tunnel '${TUNNEL_NAME}' exists"
existing_uuid="$(cloudflared tunnel list -o json \
  | jq -r --arg n "$TUNNEL_NAME" '.[] | select(.name==$n) | .id' \
  | head -n1)"

if [[ -n "$existing_uuid" ]]; then
  echo "    tunnel '${TUNNEL_NAME}' already exists (UUID=${existing_uuid}); skipping create"
else
  echo "    creating tunnel '${TUNNEL_NAME}'"
  cloudflared tunnel create "$TUNNEL_NAME"
fi

# ── Step 3: resolve UUID ─────────────────────────────────────────────────
say "Step 3/5 — resolving tunnel UUID"
UUID="$(cloudflared tunnel list -o json \
  | jq -r --arg n "$TUNNEL_NAME" '.[] | select(.name==$n) | .id' \
  | head -n1)"

if [[ -z "$UUID" ]]; then
  echo "ERROR: could not resolve UUID for tunnel '${TUNNEL_NAME}'" >&2
  exit 1
fi
echo "    UUID=${UUID}"

CRED_FILE="${CF_DIR}/${UUID}.json"
CERT_FILE="${CF_DIR}/cert.pem"
for f in "$CRED_FILE" "$CERT_FILE"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing required file: $f" >&2
    exit 1
  fi
done

# ── Step 4: SCP credentials to EC2 ───────────────────────────────────────
say "Step 4/5 — copying credentials to ${FORGE_EC2_HOST}:~/.cloudflared/"
ssh "$FORGE_EC2_HOST" 'mkdir -p ~/.cloudflared'
scp "$CERT_FILE" "$CRED_FILE" "${FORGE_EC2_HOST}:~/.cloudflared/"

# ── Step 5: finalize on EC2 ──────────────────────────────────────────────
say "Step 5/5 — running forge-tunnel-finalize on ${FORGE_EC2_HOST}"
ssh "$FORGE_EC2_HOST" 'sudo /usr/local/sbin/forge-tunnel-finalize'

say "Done. Tunnel '${TUNNEL_NAME}' (UUID=${UUID}) finalized on ${FORGE_EC2_HOST}."
