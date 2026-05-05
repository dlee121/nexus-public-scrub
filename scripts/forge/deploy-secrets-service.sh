#!/usr/bin/env bash
#
# scripts/forge/deploy-secrets-service.sh
#
# Operator-side one-shot: deploy the forge-secrets.service stack to the EC2
# forge-worker host via AWS SSM. Run from a Mac/laptop with AWS CLI configured
# for the target account; nothing here touches local working state.
#
# What it does:
#   1. Builds an AWS-RunShellScript payload that, on the EC2 instance:
#        - pulls GITHUB_TOKEN from Secrets Manager
#        - downloads forge-secrets-fetch.sh, forge-secrets.service, and
#          forge-console.service from [org]/Nexus@nexus-main via the
#          GitHub Contents API (raw)
#        - installs the unit files into /etc/systemd/system/
#        - idempotently patches /etc/systemd/system/forge-worker.service
#          with `After=forge-secrets.service` and `Requires=forge-secrets.service`
#        - daemon-reload, enable+start forge-secrets.service
#        - restarts forge-worker.service and forge-console.service
#        - smokes /healthz on 127.0.0.1:4640
#   2. Sends the command, polls for completion (up to ~45s), prints stdout/stderr.
#   3. Exits non-zero with the captured output on any non-Success status.
#
# Requirements on the operator host: aws CLI v2, jq, valid AWS creds with
# ssm:SendCommand + ssm:GetCommandInvocation on the target instance.

set -euo pipefail

INSTANCE_ID="i-04d1a839cba80f2e6"
REGION="us-west-2"

command -v aws >/dev/null || { echo "aws CLI not found on PATH" >&2; exit 1; }
command -v jq  >/dev/null || { echo "jq not found on PATH" >&2; exit 1; }

# Single-quoted heredoc delimiter — no expansion in the operator's shell.
# Every $VAR below is evaluated remotely on EC2.
REMOTE_SCRIPT=$(cat <<'REMOTE_EOF'
#!/usr/bin/env bash
set -euo pipefail

REGION="us-west-2"
REPO="[org]/Nexus"
REF="nexus-main"

echo "===== fetching GITHUB_TOKEN from Secrets Manager ====="
GITHUB_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id /forge-worker/prod/GITHUB_TOKEN \
  --query SecretString \
  --output text \
  --region "$REGION")
[[ -n "$GITHUB_TOKEN" ]] || { echo "GITHUB_TOKEN missing from Secrets Manager"; exit 1; }

# Atomic fetch via Contents API (raw). Writes to .tmp then renames so a
# partial download never lands in /etc/systemd/system/.
fetch_file() {
  local repo_path="$1"
  local target_path="$2"
  local mode="$3"

  echo ">> fetching $repo_path -> $target_path"
  mkdir -p "$(dirname "$target_path")"

  local url="https://api.github.com/repos/$REPO/contents/$repo_path?ref=$REF"
  local http_status
  http_status=$(curl -sS -L -w '%{http_code}' \
    -o "$target_path.tmp" \
    -H "Accept: application/vnd.github.raw" \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "User-Agent: forge-deploy-secrets-service" \
    "$url")

  if [[ "$http_status" != "200" ]]; then
    echo "FAILED to fetch $repo_path (HTTP $http_status)" >&2
    cat "$target_path.tmp" >&2 || true
    rm -f "$target_path.tmp"
    exit 1
  fi

  mv "$target_path.tmp" "$target_path"
  chmod "$mode" "$target_path"
}

fetch_file "ec2/forge-worker/forge-secrets-fetch.sh" "/opt/nexus/core/ec2/forge-worker/forge-secrets-fetch.sh" 0755
fetch_file "ec2/forge-worker/forge-secrets.service"  "/opt/nexus/core/ec2/forge-worker/forge-secrets.service"  0644
fetch_file "forge-console/forge-console.service"     "/opt/nexus/core/forge-console/forge-console.service"     0644

echo "===== installing unit files into /etc/systemd/system/ ====="
cp /opt/nexus/core/ec2/forge-worker/forge-secrets.service /etc/systemd/system/forge-secrets.service
cp /opt/nexus/core/forge-console/forge-console.service     /etc/systemd/system/forge-console.service

WORKER_UNIT=/etc/systemd/system/forge-worker.service
if [[ -f "$WORKER_UNIT" ]]; then
  if ! grep -q '^After=.*forge-secrets\.service' "$WORKER_UNIT"; then
    sed -i '/^\[Unit\]/a After=forge-secrets.service' "$WORKER_UNIT"
    echo ">> patched $WORKER_UNIT: added After=forge-secrets.service"
  else
    echo ">> $WORKER_UNIT already has After=forge-secrets.service — skipping"
  fi
  if ! grep -q '^Requires=forge-secrets\.service' "$WORKER_UNIT"; then
    sed -i '/^\[Unit\]/a Requires=forge-secrets.service' "$WORKER_UNIT"
    echo ">> patched $WORKER_UNIT: added Requires=forge-secrets.service"
  else
    echo ">> $WORKER_UNIT already has Requires=forge-secrets.service — skipping"
  fi
else
  echo "WARN: $WORKER_UNIT not found — skipping dependency patch" >&2
fi

echo "===== ensure host-level git identity for forge worktrees ====="
# Forge spawns Claude Code sessions in /tmp/forge-worktrees/<ticketId> under
# both root (forge-worker.service runs as root) and ubuntu (legacy). git
# refuses to commit without user.name/user.email configured, which silently
# breaks the IMPLEMENT phase: CC produces edits, attempts `git commit`, and
# the commit fails with no diff against origin/main — the post-session
# guardrail then trips with "produced no commits". Set both in --global so
# every fresh EC2 host (or rebuild) inherits a valid identity. Idempotent.
for u in root ubuntu; do
  sudo -u "$u" git config --global user.name  'Forge Worker' || true
  sudo -u "$u" git config --global user.email 'forge@[company-domain]' || true
done
echo ">> git identity set for root + ubuntu: Forge Worker <forge@[company-domain]>"

echo "===== systemctl daemon-reload ====="
systemctl daemon-reload

echo "===== enable + start forge-secrets.service ====="
systemctl enable forge-secrets.service
systemctl start  forge-secrets.service

echo "===== forge-secrets.service journal (since 2 minutes ago) ====="
journalctl -u forge-secrets.service --since '2 minutes ago' --no-pager || true

echo "===== restarting forge-worker.service forge-console.service ====="
systemctl restart forge-worker.service forge-console.service

echo "===== service status ====="
systemctl status forge-worker.service forge-console.service --no-pager || true

echo "===== healthz smoke ====="
sleep 3
curl -sS http://127.0.0.1:4640/healthz | jq . || echo 'healthz not yet ready'

echo "DONE"
REMOTE_EOF
)

# Build the SSM payload. jq --arg handles all escaping for the embedded
# multi-line bash; AWS-RunShellScript expects Parameters.commands as a list
# of strings.
PAYLOAD=$(jq -n \
  --arg id  "$INSTANCE_ID" \
  --arg cmd "$REMOTE_SCRIPT" \
  '{
     InstanceIds:  [$id],
     DocumentName: "AWS-RunShellScript",
     Parameters:   { commands: [$cmd] }
   }')

echo ">> sending SSM command to $INSTANCE_ID ($REGION)"
CMD_ID=$(aws ssm send-command \
  --region "$REGION" \
  --cli-input-json "$PAYLOAD" \
  --query 'Command.CommandId' \
  --output text)

echo ">> CommandId=$CMD_ID"
echo -n ">> waiting "

# Poll up to ~45s; exit early on any terminal status.
STATUS=Pending
for _ in $(seq 1 22); do
  sleep 2
  echo -n "."
  STATUS=$(aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" \
    --query Status \
    --output text 2>/dev/null || echo InProgress)
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
done
echo

OUTPUT=$(aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" \
  --output json)

STATUS=$(echo "$OUTPUT" | jq -r '.Status')
echo ">> final status: $STATUS"
echo
echo "===== StandardOutputContent ====="
echo "$OUTPUT" | jq -r '.StandardOutputContent // ""'
echo
echo "===== StandardErrorContent ====="
echo "$OUTPUT" | jq -r '.StandardErrorContent // ""'

if [[ "$STATUS" != "Success" ]]; then
  echo
  echo "FAILED: SSM command status=$STATUS" >&2
  exit 1
fi

echo
echo "OK"
