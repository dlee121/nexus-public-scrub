---
schedule: 25 15 * * *
recurring: true
notify: error
---
Run the pre-pipeline content health check (5 min before 11:30am ET pipeline). From the Nexus core directory, execute:

  bun /Users/<user>/Nexus/core/scripts/content/health-check.ts --alert-only

IMPORTANT: Run this command synchronously — do NOT use run_in_background. Wait for it to complete before responding.

Parse the output and respond:

- Exit code 0 (HEALTHY) → reply exactly: HEARTBEAT_OK
- Exit code 1 (DEGRADED) → text Orchestrator: "heads up — content pipeline degraded before today's run: [issue]"
- Exit code 2 (CRITICAL) → alert Orchestrator urgently: "pipeline health CRITICAL — today's 11:30am run will likely fail: [issue]"

Keep it short. No bullet points.
