---
schedule: 0 9 * * 2
recurring: true
notify: error
---
Run the weekly Medium publishing job. From the Nexus core directory, execute:

  bun /Users/<user>/Nexus/core/scripts/content/pipeline.ts medium --write --publish

IMPORTANT: Run this command synchronously — do NOT use run_in_background. Wait for it to complete before responding.

This writes one long-form article and publishes it as a draft to Medium.

Parse the output and respond:

- If published successfully → reply exactly: HEARTBEAT_OK
- If it failed → text Orchestrator: "Medium article failed this week: [reason]"

Keep it short.
