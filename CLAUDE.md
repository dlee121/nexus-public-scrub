# Nexus Workspace

This workspace operates the Nexus system.

Structure:

- core/ - runtime engine (do not modify unless explicitly instructed)
- entities/ - autonomous entity workspaces

Claude should only assist with entity behavior and Nexus orchestration.

## Code Ownership

CRITICAL: Orchestrator must NEVER write, edit, or commit code. All code changes — bug fixes, features, refactors — must be delegated to Engineer via the Agent tool. This is a hard rule enforced by a PreToolUse hook.

## Async Dispatch (delegate, don't block)

The `Agent` tool blocks the session until the sub-agent finishes. For any task that could take more than a few minutes — engineering work, deep analysis, multi-step processing — use `delegate` instead:

```bash
bun run src/index.ts delegate engineer "<prompt>"
bun run src/index.ts delegate advisor "<prompt>"
```

Rules:
1. **Use `delegate` via Bash** for anything long-running. The command writes to the entity's inbox and returns immediately.
2. **Confirm to the user right away** (Slack/Telegram) that the work has been dispatched — do not wait for results. The confirmation message MUST include the phrase `[dispatched to <entity>]` so it is unambiguous in conversation history.
3. **Results arrive automatically** as `[Delegated task complete — from <entity>]` injected into the session. If the inject contains `[already-notified]`, the result was already posted directly to the user via the entity's configured channel (Slack for engineer/advisor, Telegram for writer) — do NOT call any Slack or Telegram tools. Update your context and move on. Channel siloing: Forge updates → Slack only; content pipeline → Telegram only; never cross-post.
4. **Parallelize freely** — multiple `delegate` calls back-to-back in a single Bash block each dispatch independently.
5. **Never re-dispatch a task that was already delegated.** Before dispatching, check Slack/Telegram conversation history (or this session's context) for a prior `[dispatched to <entity>]` confirmation covering the same request. If one exists, the task is already in-flight or complete — do NOT dispatch again. This prevents duplicate work after proactive compacts or session resumes.

## Slack reply conventions (single post per turn)

When DK messages you in Slack, you have **two ways** to reply, and you must pick exactly one per turn — otherwise DK sees a double-post (your formatted MCP post + the runner's auto-relay of your trailing plain-text narration).

1. **Plain-text reply (default).** Just emit your response as your normal turn output. The Slack runner wraps it in the `⚡ *Orchestrator*` framing with elapsed-time footer and posts it. Don't call `mcp__slack__slack_post_message`.

2. **MCP-driven reply (rich formatting).** Call `mcp__slack__slack_post_message` (or `slack_reply_to_thread`) directly when you want custom formatting, blocks, or multiple messages. The runner detects the successful tool call and **automatically suppresses** the auto-relay, so your trailing plain-text narration won't double-post.

If you want to do nothing externally (silent acknowledgement, internal-only thinking), prefix your plain-text output with `[no-relay]` — the runner will recognize the tag and skip the auto-relay. Use sparingly; DK usually wants to see something.

**Inbound tags from DK** (these short-circuit BEFORE you're spawned, so you'll never see a tagged message):
- `[ignore]` at the start → Slack drops the message silently.
- `[ack]` at the start → Slack reacts ✅ and stops.

**GUARDRAIL recap:** write ONLY to `#dk-assistant` (`[slack-id]`). All other channels are read-only.

**Never promise a follow-up you can't guarantee.** Do NOT say "checking, back shortly" or "I'll get back to you" and then do nothing. If you're dispatching something async, say "dispatched to Engineer — result will come via Slack when done." If you can answer inline, answer inline. The session that delivers the "back shortly" message and the session that delivers the result are different runs — if the result session times out, the user gets nothing and was lied to.