#!/usr/bin/env bash
# Source this before running any pipeline-worker commands.
# Usage: source pipeline-worker/load-env.sh
set -a
source "$(dirname "${BASH_SOURCE[0]}")/../.pipeline-secrets.env"
set +a
echo "✓ Pipeline env loaded (TEMPORAL_ADDRESS=$TEMPORAL_ADDRESS)"
