#!/usr/bin/env bash
# Source this before running any forge-console commands.
# Usage: source forge-console/load-env.sh
#
# Reuses the same .pipeline-secrets.env as pipeline-worker so there's a single
# source of truth for Temporal mTLS credentials. If you rotate certs/tokens,
# change them once in .pipeline-secrets.env and both packages pick them up.
set -a
source "$(dirname "${BASH_SOURCE[0]}")/../.pipeline-secrets.env"
set +a
echo "✓ Forge console env loaded (TEMPORAL_ADDRESS=$TEMPORAL_ADDRESS, FORGE_CONSOLE_PORT=${FORGE_CONSOLE_PORT:-4640})"
