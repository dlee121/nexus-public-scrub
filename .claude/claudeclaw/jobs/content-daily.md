---
schedule: 30 15 * * *
recurring: true
notify: error
---
Run the daily content pipeline detached so it survives session teardown. Execute:

  nohup bash /Users/<user>/Nexus/core/scripts/content/run-pipeline-detached.sh > /tmp/nexus-pipeline.log 2>&1 &

Then immediately respond: HEARTBEAT_OK

The script runs the pipeline in the background, parses per-site publish counts, and sends a Telegram message when it finishes (success or failure). No need to wait -- the notification arrives automatically.
