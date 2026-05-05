---
schedule: 3 14 * * 1
recurring: true
notify: error
---
Run the weekly Google Search Console SEO report. From the Nexus core directory, execute:

  bun /Users/<user>/Nexus/core/scripts/content/search-console.ts

IMPORTANT: Run this command synchronously — do NOT use run_in_background. Wait for it to complete before responding.

This submits sitemaps and queries impressions, clicks, and top keywords for all 3 sites, then sends a Telegram report to Orchestrator.

Parse the output and respond:

- If report sent successfully → reply exactly: HEARTBEAT_OK
- If it failed → text Orchestrator: "Search Console weekly report failed: [reason]"

Keep it short.
