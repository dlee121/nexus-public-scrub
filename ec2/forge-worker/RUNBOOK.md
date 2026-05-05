# Forge worker secrets — AWS Secrets Manager migration runbook

Operations doc for the migration introduced by this PR. Eliminates plaintext credentials in `/run/forge-worker.env` by fetching from AWS Secrets Manager at every service start via IAM role.

What this migration does NOT touch: Claude OAuth credentials at `/root/.claude/.credentials.json`. Those continue to be pushed by the launchd-driven `scripts/sync-claude-creds.sh` from the operator's Mac.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  EC2 instance (forge worker host)                        │
│                                                          │
│   forge-secrets.service  ◄──── IAM role ──► AWS SM      │
│         │ (oneshot, runs once at boot)                   │
│         │                                                │
│         ▼                                                │
│   /run/forge-worker.env       /run/forge-worker/         │
│   (tmpfs, 0600 root)            ├── temporal-tls.crt    │
│         │                       └── temporal-tls.key     │
│         │                                                │
│         ▼                                                │
│   forge-worker.service  +  forge-console.service         │
│   (Requires=forge-secrets.service)                       │
└─────────────────────────────────────────────────────────┘
```

Three units, one job per unit:

| Unit | Type | Job |
|---|---|---|
| `forge-secrets.service` | oneshot | Pulls all secrets under `/forge-worker/prod/*` from SM, writes to `/run/forge-worker.env` and `/run/forge-worker/temporal-tls.{crt,key}`. |
| `forge-worker.service` | simple | Temporal worker. `Requires=forge-secrets.service`. |
| `forge-console.service` | simple | Operator UI. `Requires=forge-secrets.service`. |

The `Requires=` wiring means: if `forge-secrets.service` fails (IAM denied, SM unreachable, missing key), neither consumer starts. Fail-closed.

---

## Secret naming convention

Every secret in SM is named:

```
/forge-worker/prod/<KEY>
```

Where `<KEY>` is exactly the env var name. So `/forge-worker/prod/GITHUB_TOKEN` projects to `GITHUB_TOKEN=<value>` in `/run/forge-worker.env`.

Two keys are special-cased — their value is PEM content, written to a file rather than projected as a string:

| SM key | File path written | Env var set in env file |
|---|---|---|
| `TEMPORAL_TLS_CERT` | `/run/forge-worker/temporal-tls.crt` (0444) | `TEMPORAL_TLS_CERT_PATH` |
| `TEMPORAL_TLS_KEY` | `/run/forge-worker/temporal-tls.key` (0400) | `TEMPORAL_TLS_KEY_PATH` |

---

## Inventory: what to populate in SM

This is the list of secrets currently consumed by the worker + console (sourced from `pipeline-worker/src/`, `forge-console/src/`, and `server/forge-proxy.js` — re-derive before populating if the codebase has moved):

| SM key | Notes |
|---|---|
| `TEMPORAL_TLS_CERT` | PEM contents of the Temporal Cloud client cert |
| `TEMPORAL_TLS_KEY` | PEM contents of the Temporal Cloud client key |
| `FORGE_API_TOKEN` | Shared secret with the web app for `/forge/exchange` HMAC + X-Forge-Token |
| `FORGE_EVENT_TOKEN` | Worker → console event ingestion shared secret |
| `GITHUB_TOKEN` | Fine-grained PAT scoped to [org]/Nexus + [org]/* repos used by activities |
| `LINEAR_API_KEY` | Linear API token used by patrol activity for issue creation |
| `OPENAI_API_KEY` | Used by plan-generation activity |
| `SLACK_XOXB_TOKEN` | Forge updates → #dk-forge-alerts (DKAssist bot user; xoxb-). NOT to be confused with Orchestrator's user-scoped `SLACK_BOT_TOKEN` (xoxp-) used by the operator MCP — that one stays out of the worker. |
| `TELEGRAM_BOT_TOKEN` | Content pipeline notifications |
| `CLICKHOUSE_PASSWORD` | If the worker host runs any ClickHouse-touching scripts |

These config keys stay as plain `Environment=` directives in the service unit (NOT in SM):

```
TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, NEXUS_CORE_PATH, AWS_REGION,
FORGE_CONSOLE_URL, FORGE_CONSOLE_HOST, FORGE_CONSOLE_PORT,
FORGE_DEPLOY_CHECKOUT_BASE, FORGE_WORKTREE_BASE, LINEAR_TEAM_ID
```

The populate script (`populate-sm.sh`) hardcodes this skip list.

---

## Migration procedure

### One-time — host binaries

Some pipeline phases shell out to host binaries that aren't part of the worker package itself. Run once on the EC2 host:

```bash
sudo bash /opt/nexus/core/ec2/forge-worker/host-prereqs.sh
```

The script is idempotent. Today it installs:

- **`gh` CLI** — required by the `/review` skill that runs inside the REVIEW phase of the pipeline. The skill's frontmatter hard-restricts `allowed-tools` to specific `gh` subcommands, so it cannot be replaced with Octokit calls inside the spawned CC session. Auth is via the `GH_TOKEN` env var the worker mirrors from `GITHUB_TOKEN` — no `gh auth login` needed on the host.

### One-time — AWS side

Done from your Mac (where you have AWS console access), not on the EC2.

1. **Create the IAM policy.**
   ```bash
   aws iam create-policy \
     --policy-name ForgeWorkerSecretsRead \
     --policy-document file:///path/to/Nexus/core/ec2/forge-worker/iam-policy.json \
     --description "Read /forge-worker/prod/* from AWS Secrets Manager"
   ```
   Note the returned `Arn`.

2. **Attach the policy to the EC2 instance role.**
   The forge-worker EC2 instance has an instance profile (call it whatever the existing one is named — check the EC2 console → Instance → IAM role).
   ```bash
   aws iam attach-role-policy \
     --role-name <existing-instance-role> \
     --policy-arn arn:aws:iam::<account>:policy/ForgeWorkerSecretsRead
   ```
   If there's no existing instance role, create one with the standard EC2 trust policy and attach this policy plus enough to keep the existing service running (CloudWatch logs, etc.). Then assign the instance profile to the EC2 instance.

3. **Verify from EC2.** SSH in and run:
   ```bash
   aws sts get-caller-identity     # should show the role's ARN
   aws secretsmanager list-secrets --max-results 1 --filters Key=name,Values=/forge-worker/
   ```

### One-time — populate SM with current values

On the EC2 host, with the existing `/run/forge-worker.env` still in place:

1. **Dry-run first.** Confirm the script reads what you expect.
   ```bash
   sudo bash /opt/nexus/core/ec2/forge-worker/populate-sm.sh --dry-run
   ```

2. **Run for real.** Interactive mode prompts before each secret:
   ```bash
   sudo bash /opt/nexus/core/ec2/forge-worker/populate-sm.sh
   ```
   Or non-interactive:
   ```bash
   sudo bash /opt/nexus/core/ec2/forge-worker/populate-sm.sh --yes
   ```

3. **Verify.** Should list every projected key:
   ```bash
   aws secretsmanager list-secrets --filters Key=name,Values=/forge-worker/prod/
   ```

### Cutover — install systemd units

Still on the EC2 host:

1. **Copy units into systemd's load path.**
   ```bash
   sudo cp /opt/nexus/core/ec2/forge-worker/forge-secrets.service /etc/systemd/system/
   sudo cp /opt/nexus/core/forge-console/forge-console.service   /etc/systemd/system/
   # forge-worker.service is hand-rolled on this host — diff against
   # ec2/forge-worker/forge-worker.service.example and add:
   #   After=forge-secrets.service
   #   Requires=forge-secrets.service
   sudo systemctl daemon-reload
   ```

2. **Enable forge-secrets to run on boot, and run it once now to validate.**
   ```bash
   sudo systemctl enable forge-secrets.service
   sudo systemctl start forge-secrets.service
   sudo systemctl status forge-secrets.service        # expect: active (exited)
   sudo journalctl -u forge-secrets.service --since '1 minute ago' --no-pager
   ```

   What success looks like in the journal:
   ```
   forge-secrets-fetch.sh[XXX]: [forge-secrets] fetching secrets under /forge-worker/prod (region=us-west-2, mode=strict)
   forge-secrets-fetch.sh[XXX]: [forge-secrets] found 9 secret(s) under prefix
   forge-secrets-fetch.sh[XXX]: [forge-secrets]   GITHUB_TOKEN → set
   ...
   forge-secrets-fetch.sh[XXX]: [forge-secrets] wrote 9 env entries to /run/forge-worker.env
   ```

3. **Confirm the env file is valid.**
   ```bash
   sudo ls -la /run/forge-worker.env /run/forge-worker/
   sudo head -1 /run/forge-worker.env             # should show the "fetched from AWS Secrets Manager" comment
   sudo wc -l /run/forge-worker.env               # roughly: header lines + N projected keys
   ```

4. **Restart the consumer services.**
   ```bash
   sudo systemctl restart forge-worker.service forge-console.service
   sudo systemctl status forge-worker.service forge-console.service
   ```

5. **Smoke the console.**
   ```bash
   curl -sS http://127.0.0.1:4640/healthz | jq .
   ```

### Cleanup

Once everything is stable for at least one full day:

1. **Move the persistent backup of /run/forge-worker.env off the host.**
   It probably lives at `~/forge-worker.env` or similar from the original deploy. Encrypt and stash it offline (you'll want it for emergency restore until SM is proven). Then `sudo shred -u <path>` to remove from disk.

2. **Delete the IAM user / static creds the host previously used,** if any. Now that the instance role grants SM access, no static AWS keys should be on the box.

3. **Set `FORGE_SECRETS_MODE=strict` if you'd flipped to `soft` for cutover.** It's the default; just make sure the override isn't lingering in the unit file.

---

## Rollback

If anything breaks after cutover:

1. **Fast path — re-stage the old env file and restart consumers.**
   ```bash
   sudo cp /path/to/backup/forge-worker.env /run/forge-worker.env
   sudo chmod 0600 /run/forge-worker.env
   sudo systemctl stop forge-secrets.service              # don't let it overwrite
   sudo systemctl mask forge-secrets.service              # firmly off
   # Edit forge-console.service + forge-worker.service: remove the
   # `Requires=forge-secrets.service` line (After= is harmless to leave).
   sudo systemctl daemon-reload
   sudo systemctl restart forge-worker.service forge-console.service
   ```

2. **Or the soft-mode trick.** If SM is flaky but the env file is still good from a recent successful fetch, switch the service to soft mode so it tolerates SM failures:
   ```bash
   sudo systemctl edit forge-secrets.service
   # In the editor, add:
   #   [Service]
   #   Environment=FORGE_SECRETS_MODE=soft
   sudo systemctl daemon-reload
   sudo systemctl restart forge-secrets.service
   ```

---

## Operations

### Rotating a secret

1. Update the value in SM:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id /forge-worker/prod/GITHUB_TOKEN \
     --secret-string "<new-value>"
   ```
2. Restart the secrets oneshot, which re-reads from SM and rewrites the env file:
   ```bash
   sudo systemctl restart forge-secrets.service
   ```
3. Restart any consumer service that holds the old value in memory:
   ```bash
   sudo systemctl restart forge-worker.service forge-console.service
   ```

### Adding a new secret

1. Create the SM entry — name must match the env var the consumer expects:
   ```bash
   aws secretsmanager create-secret \
     --name /forge-worker/prod/NEW_THING_API_KEY \
     --secret-string "<value>"
   ```
2. `sudo systemctl restart forge-secrets.service` to pick it up.
3. No code change needed in the prestart script — it enumerates the prefix.

### Inspecting current state on the host

```bash
# Was the last secrets fetch clean?
sudo systemctl status forge-secrets.service
sudo journalctl -u forge-secrets.service --since today --no-pager

# What's in the env file right now?
sudo cat /run/forge-worker.env | sed 's/=.*/=<redacted>/'

# Does the IAM role actually have the policy attached?
aws sts get-caller-identity
aws iam list-attached-role-policies --role-name <instance-role-name>
```

### Audit trail

Every `GetSecretValue` call goes to CloudTrail. To pull the last 24h of forge-worker secret reads:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue \
  --start-time "$(date -u -v-1d +%Y-%m-%dT%H:%M:%SZ)" \
  --query 'Events[?contains(Resources[].ResourceName, `/forge-worker/`)]' \
  | jq '.[] | {time: .EventTime, secret: .Resources[0].ResourceName, source: .SourceIPAddress}'
```
