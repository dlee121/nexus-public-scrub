#!/usr/bin/env bash
# Idempotent installer for binaries the forge-worker needs on the host
# beyond what `forge-worker.service` itself provides.
#
# Currently:
#   - GitHub CLI (`gh`) — required by the /review skill spawned in the
#     REVIEW phase of the pipeline. The skill's frontmatter hard-restricts
#     allowed-tools to specific `gh` subcommands; we cannot replace it
#     with octokit calls inside the CC session.
#
# Run this once per fresh EC2 host (Ubuntu 22.04+). Safe to re-run — every
# step short-circuits if already done.

set -euo pipefail

log() { printf '[host-prereqs] %s\n' "$*"; }

# --- gh CLI ---------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  log "gh already installed: $(gh --version | head -1)"
else
  log "installing gh CLI…"
  if ! command -v curl >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y curl
  fi
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y gh
  log "gh installed: $(gh --version | head -1)"
fi

# --- gh auth check --------------------------------------------------------
# The forge-worker service projects GITHUB_TOKEN from /run/forge-worker.env
# into the spawned CC session, and src/lib/cc-streamed.ts mirrors that to
# GH_TOKEN. So gh authenticates implicitly inside the session — no
# `gh auth login` needed and we should not run one here either.
log "gh auth model: GH_TOKEN env var (set per-session by cc-streamed). No login required on the host."

log "done."
