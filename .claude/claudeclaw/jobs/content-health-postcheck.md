---
schedule: 30 16 * * *
recurring: true
notify: error
---
Run the post-pipeline content health check (1 hour after 11:30am ET pipeline). From the Nexus core directory, execute:

  bun /Users/<user>/Nexus/core/scripts/content/health-check.ts --alert-only

IMPORTANT: Run this command synchronously — do NOT use run_in_background. Wait for it to complete before responding.

Parse the output and respond:

- Exit code 0 (HEALTHY) → reply exactly: HEARTBEAT_OK
- Exit code 1 (DEGRADED) → text Orchestrator: "pipeline ran but something's off: [issue]"
- Exit code 2 (CRITICAL) → alert Orchestrator: "post-run health check failed: [issue]. Check data/content/logs/"

Keep it short. No bullet points.
