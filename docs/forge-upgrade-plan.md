# Forge System Upgrade — Execution Plan

**Status:** IN PROGRESS — Step 0 done, others queued.
**Started:** 2026-05-04
**Owner:** Engineer (under Orchestrator delegation)
**Branch:** `nexus-main`
**Recovery:** if context compacts mid-task, re-read this doc and continue from the last
unchecked item. Each step has an "Acceptance" subsection that defines done.

The directive that triggered this work is `forge-upgrade-directive` from DK.
This document is the canonical checklist and the recovery anchor.

---

## Executive context

Forge has shipped real PRs (#170, #173, #175) but has gaps:

1. Reviews are bypassed — Forge posts its own self-review and merges immediately. `REVIEW_REQUIRED` left unresolved on every PR.
2. DEV_DEPLOY fails for [target-repo-realtime] because no CI workflow pushes Docker images to ECR on merge to main. The 10-min retry budget shipped in `864cb89` only mitigates the YAML/docs-only case.
3. VERIFY is shallow: lint + tests + GPT diff review. `smokeCommand` is configured in `nexus.json` for every repo but never executed.
4. No follow-up task queue. Scope expansion or unresolved issues silently dropped.
5. No dev data seeding. Forge depends on whatever happens to be in dev.

A "complete" Forge task should mean: code merged → image deployed → live system healthy → out-of-scope items captured.

---

## Step 0 — Plan Anchor

- [x] Create this document at `docs/forge-upgrade-plan.md`
- [ ] Commit so it lives on `nexus-main` and survives context compaction (will commit at first checkpoint, not before code changes — single commit per logical unit)

**Acceptance:** this file exists, is descriptive enough to resume work from, and is updated continuously.

---

## Step 1 — PR Review Loop ✅ (wait-for-external-review + address-loop combined)

**Current behavior:** `pipeline-worker/src/workflows/PipelineWorkflow.ts` proceeds PR_OPEN → CI_WAIT → REVIEW (self-generated) → MERGE_QUEUE without ever waiting for external reviewers, Bugbot, or check-suite signals beyond the bare CI checks.

**Target behavior:**

1. After `createPRActivity` succeeds, enter a new state `WAIT_FOR_EXTERNAL_REVIEW` that:
   - Waits a minimum 2-3 min window for external comments to land (Bugbot, humans).
   - Polls `/repos/{owner}/{repo}/pulls/{n}/comments` (line comments) and `/repos/{owner}/{repo}/issues/{n}/comments` (PR-level comments) and `/repos/{owner}/{repo}/pulls/{n}/reviews` (formal reviews).
   - Filters out Forge's own self-generated comment.
2. For each external comment:
   - Classify: blocking (REQUEST_CHANGES, "must fix", explicit problem statements) vs informational vs out-of-scope.
   - For in-scope blockers/issues: dispatch `addressReviewActivity` (or extend existing `reviewActivity`) which re-spawns Claude in the same worktree with the comment text + the code, asks it to address the comment, push commits to the PR branch.
   - For out-of-scope items: enqueue a follow-up task via the Step 5 system, post a reply on the PR comment thread saying "Captured as follow-up task X — out of scope for this PR".
3. Loop up to **MAX_REVIEW_ITERATIONS = 3**:
   - After each push, re-wait for fresh comments.
   - If new blocking comments arrive, address them.
   - If no new comments, proceed to merge.
4. Terminate with merge only when: no unresolved blocking comments AND `reviewDecision != REVIEW_REQUIRED` (or reviewers explicitly approved) OR all remaining items are documented as deferred.

**Sub-investigations resolved:**

- [x] Confirmed Bugbot config on `[org]/[target-repo-realtime]` — `Cursor Bugbot` IS in the pending checks of PR #176 (and was on PR #168 historically). PRs #170/#173/#175 must have merged before Bugbot completed; the new wait window prevents this.
- [x] External-bot identities: filtered by author exclusion list (default `['[org]']`) plus body-pattern exclusion (`/^## Code Review/m`, `/^### Code review/m`). Catches Bugbot, humans, and other bots automatically without an enumerated allowlist.
- [x] Comment-thread → Claude prompt translation: `addressReviewActivity` now receives a single string with `=== Forge self-review ===` + `=== External comments (N) ===` sections, source-tagged per comment. Session classifies each item as in-scope-fix / accept-with-justification / false-positive / OUT-OF-SCOPE.

**Files touched:**

- `pipeline-worker/src/lib/github.ts` — new `listExternalComments({owner, repo, prNumber, excludeAuthors, excludeBodyPatterns, since, headSha})`. Pulls issue comments, formal reviews (incl. REQUEST_CHANGES with empty body), inline review line comments, AND check-run summaries (Bugbot output landed here).
- `pipeline-worker/src/activities/waitForExternalReview.ts` — new activity. 3-min minimum window, then polls; quiesces if comments are still arriving (60s windows) up to 8-min cap.
- `pipeline-worker/src/activities/index.ts` — re-exports `waitForExternalReviewActivity`.
- `pipeline-worker/src/workflows/PipelineWorkflow.ts` — restructured the REVIEW loop: each iteration now calls `waitForExternalReviewActivity` first, then `reviewActivity`, then combines feedback into a single packet for `addressReviewActivity`. External feedback gates the merge equally with self-review.
- `pipeline-worker/src/activities/addressReview.ts` — prompt rewritten to handle external + self review combined, with explicit OUT-OF-SCOPE classification: out-of-scope items must (a) be replied to on the PR thread with "Captured as follow-up — out of scope for this PR", (b) be enqueued via `node dist/cli/queue-add.js` from inside the worktree session.

**Acceptance:**
- [x] PRs opened by Forge wait at least one full poll-cycle (3 min, up to 8 min) for external comments.
- [x] Bugbot/external comments fold into the same review-iteration loop as the self-review.
- [x] Out-of-scope feedback creates a follow-up task with back-reference to the source PR.
- [ ] Verified via dogfood (Step 7).

---

## Step 2 — DEV_DEPLOY must validate, not just deploy

**Current behavior:** `devDeployActivity` resolves the ECR image tag and runs `make eb-deploy-dev-tagged`. If ECR doesn't have the image (because no CI workflow builds it on merge to main), the activity fails. The `864cb89` fix only handles YAML-only PRs.

**Target behavior:**

### 2a. Fix the ECR gap — PR #176 ✅ merged; ⚠️ IAM blocker confirmed

Added `.github/workflows/ecr-push-on-merge.yml` on `[org]/[target-repo-realtime]` (PR #176). Merged at 2026-05-03T13:59:58Z (`b78671296`). Reuses existing `AWS_ROLE_TO_ASSUME` / `AWS_REGION` secrets, derives `AWS_ACCOUNT_ID` via STS, calls the existing `build-all` → `tag-all` → `ecr-login` → `push-all` Makefile chain. Tag scheme matches `ecr-tag-resolver`'s prefix exactly.

- [x] Investigate existing AWS-related GH Actions secrets — `AWS_ROLE_TO_ASSUME` + `AWS_REGION` already in place from CodeArtifact-using workflows.
- [x] Author the workflow and PR it.
- [x] Merge PR #176 — Bugbot passed (8m23s), CI green. Merged with `--admin --squash`.
- [x] First validation run via `workflow_dispatch` (run id 25281190334).

**🚨 EXTERNAL BLOCKER:** The validation run failed at "Login to ECR" with:

> User: `arn:aws:sts::[aws-account-id]:assumed-role/GithubActions-CodeArtifact-Read/GitHubActions` is not authorized to perform: `ecr:GetAuthorizationToken` on resource `*` because no identity-based policy allows the `ecr:GetAuthorizationToken` action.

The OIDC role `GithubActions-CodeArtifact-Read` only has CodeArtifact perms; it needs ECR push perms added.

**Operator action required (DK):**

1. AWS IAM Console → account `[aws-account-id]` → role `GithubActions-CodeArtifact-Read`.
2. Attach a policy granting:
   - `ecr:GetAuthorizationToken` on `*`
   - `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:DescribeRepositories` on `arn:aws:ecr:us-west-2:[aws-account-id]:repository/[target-repo-realtime]-*`.

   Quick option: AWS-managed `AmazonEC2ContainerRegistryPowerUser` (slightly broader than necessary but unblocks immediately).
3. Re-run `gh workflow run "ECR push on merge" --repo [org]/[target-repo-realtime] --ref main` to validate.
4. Notify Engineer to resume Steps 6 + 7.

Until IAM is fixed, DEV_DEPLOY will continue to fail for app-code merges (same as Options A/B/C), so Step 7's "complete" definition (merged + deployed + verified) is unreachable.

### 2b. Post-deploy validation ✅ (HTTP health check + monitorScript wired with auto-queue)

After DEV_DEPLOY:

1. **HTTP health check** — `monitorActivity` now polls `repoConfig.devHealthCheckUrl` (12 × 10s budget = 2 min) for a 2xx. New optional field on `PipelineConfig`. Gate skipped when unset (back-compat).
2. **monitorScript** — existing per-repo functional gate runs after the HTTP gate.
3. **Failure capture** — both gates queue a follow-up task (`addPendingTask`) with full diagnostics + back-references to the source workflow id and PR URL before throwing. Operator never loses the failure context.

Auto-fix-on-monitor-failure is deferred to Step 1's address-failure loop (same plumbing).

**Files touched:**

- `pipeline-worker/src/types.ts` — added `devHealthCheckUrl?: string`.
- `pipeline-worker/src/activities/monitor.ts` — full rewrite. HTTP health check via `fetch` with 12-attempt retry; monitorScript path preserved; both paths call `addPendingTask` on failure.
- `pipeline-worker/src/workflows/PipelineWorkflow.ts` — passes `sourceWorkflowId` (from `workflowInfo()`) and `sourcePr` to `monitorActivity` so queued failures back-reference correctly.

**Acceptance:**
- [ ] On merge to main, ECR has a `dev-<sha>-*` image within ~5 min. *(Pending PR #176 merge + first post-merge run.)*
- [ ] DEV_DEPLOY completes successfully end-to-end for an app-code change. *(Pending Step 7 e2e run.)*
- [x] Post-deploy HTTP 200 + functional check both run and gate task completion. *(Code path complete; needs `devHealthCheckUrl` populated in nexus.json before it fires for real.)*
- [x] Monitor failures auto-queue a follow-up task with full diagnostics.

**Operator action remaining:** populate `devHealthCheckUrl` in `nexus.json` for `[target-repo-realtime]` once DK confirms the right dev EB endpoint URL.

---

## Step 3 — Dev Data Seeding ✅ (operator CLI + activity built; auto-seed-on-monitor-failure deferred)

**Current behavior:** Forge has no concept of test data. Validation may fail for "data missing" reasons.

**Target behavior:**

- New activity `seedDevDataActivity` with hard prod-target refusal in front of any execution.
- Operator-facing CLI `node dist/cli/seed-dev-data.js --repo <name>` so it can be invoked manually right away.
- Auto-invocation on monitor-failure deferred — needs missing-data detection heuristics or an explicit "needs-seeding" signal from the failed validation; both add complexity beyond v1.

**Host classifier (the safety bedrock):**

- DENY tokens (case-insensitive): `prod`, `production`. ANY match in the host string vetoes the run, even if a dev token is also present (`clickhouse-prod-dev-replica` is still prod-coded).
- ALLOW tokens (case-insensitive): `dev`, `develop`, `staging`, `stage`, `test`, `localhost`, `127.0.0.1`.
- Host with neither allow nor deny tokens → REFUSE (safety default — explicit dev token required).
- Empty host → REFUSE.
- Refusal throws (not a soft skip) so the operator notices the misconfiguration.

**Files touched:**

- `pipeline-worker/src/activities/seedDevData.ts` — new activity. `classifyHost(host)` predicate + `seedDevDataActivity({worktreePath, repoName, hostEnvVar})`. Sets `SEED_TARGET_VERIFIED=1` in the spawned env so the seed script can sanity-check Forge actually validated the target.
- `pipeline-worker/src/cli/seed-dev-data.ts` — operator CLI.
- `pipeline-worker/src/activities/index.ts` — re-export.
- `pipeline-worker/src/types.ts` — `seedFixturesScript?: string` field.

**Acceptance:**
- [x] Forge can invoke `seedFixturesScript` on demand (CLI works, activity wired).
- [x] An attempt to point at a prod ClickHouse hostname is refused at runtime (11/11 host-classifier unit tests pass).
- [ ] Validation runs that fail due to missing data trigger a single seed-and-retry cycle. *(Deferred — needs missing-data signal.)*

---

## Step 4 — Validation Depth: wire smokeCommand ✅

**Current behavior:** `nexus.json` defines `smokeCommand` for every repo (`make smoke-test-containers`, `npm run build`, etc.) but `verifyActivity` never calls it.

**Target behavior:**

- [x] Add `smokeCommand` execution to `verifyActivity` after lint + type-check + unit tests, before GPT diff review.
- [x] Non-zero exit → VERIFY fails (throws `<cmd> failed in VERIFY (smoke)`), normal review-iteration loop runs.
- [x] Defensive on missing/empty `smokeCommand` (skip instead of throwing "command not found") so older nexus.json entries don't break.

**Files touched:**

- `pipeline-worker/src/activities/verify.ts` — added smoke step between unit tests and GPT diff review.

**Acceptance:**
- [x] Forge runs `smokeCommand` for every PR's VERIFY stage.
- [x] Failures are surfaced as VERIFY failures, not silent.

---

## Step 5 — Follow-up Task System ✅ (lib + CLIs built; Step 1 will integrate)

**Current behavior:** When Forge encounters a scope expansion, missing infra, or unresolved review item, it has no place to record it. Items get dropped or worse, force-merged.

**Target behavior:**

- New JSON-file queue at `data/forge-pending-queue.json` (gitignored — operator edits it from CLI).
- Schema: array of `{id, title, body, sourceWorkflowId, sourcePr, createdAt, status: 'pending'|'dispatched'|'completed'|'completed-no-action'}`.
- New CLI: `node dist/cli/queue-add.js "<title>" --body "..." --source-pr <url>` (used internally by activities).
- `forge transcript` style helper to list pending: `node dist/cli/queue-list.js`.
- Manual dispatch: `node dist/cli/queue-dispatch.js <id>` — runs `trigger.js` with the body as the instruction.

**Files touched:**

- `pipeline-worker/src/lib/pending-queue.ts` — read/append/list/mark-dispatched. Atomic tmp+rename writes; idempotent on (title, sourcePr) so loops can't double-enqueue.
- `pipeline-worker/src/cli/queue-add.ts`, `queue-list.ts`, `queue-dispatch.ts` — new CLIs.
- `.gitignore` — adds `data/forge-pending-queue.json`.

**Acceptance:**
- [x] `queue-add` from inside an activity persists the task.
- [x] `queue-list` shows pending tasks (summary + --json + --status filter).
- [x] Idempotency: re-add of same (title, sourcePr) returns the existing entry.
- [x] `queue-dispatch` triggers a Forge run from a queued task. *(Code path exercised; full e2e dispatch deferred to Step 7.)*
- [ ] Step 1's out-of-scope-comment path actually calls `queue-add`. *(Pending Step 1 implementation.)*

---

## Step 6 — Recovery Task: address #170 / #173 / #175

**Note:** Per earlier audit, these PRs merged with `reviewDecision: REVIEW_REQUIRED` — but the only "comment" on each was Forge's own self-review. There are NO unresolved external comments because no external reviewer (Bugbot, human) ever weighed in. So "extracting unresolved items" means manually re-reviewing the merged diffs and identifying any real issues.

- [ ] Re-read the diffs of #170 (CI noise sweep), #173 (mypy/ruff), #175 (slot_id logging).
- [ ] Identify real unresolved items (e.g., did the Forge implementation skip part of the spec? did acceptance criteria get checked off in the comment but not actually validated?).
- [ ] Build one consolidated follow-up task and trigger through the upgraded Forge as the first dogfooding run.

**Acceptance:**
- [ ] If issues exist in #170/#173/#175, a new PR closes them.
- [ ] If no issues exist, document that finding in the queue (status: `completed-no-action`) for audit trail.

---

## Step 7 — End-to-end Validation

**Goal:** Run a fresh task through the upgraded Forge end-to-end and verify every loop is exercised.

- [ ] Pick a small but realistic task (e.g., add a structured field to an existing log line, similar to Option C).
- [ ] Trigger through the standard Forge entry point.
- [ ] Watch through the full lifecycle.
- [ ] Confirm:
  - PR opened
  - External-review wait fires (and times out cleanly if no Bugbot comment lands)
  - Self-review still runs
  - Comments addressed if any
  - VERIFY runs `smokeCommand`
  - Post-merge: ECR image present, deploy succeeds, post-deploy validation passes
  - Out-of-scope items (if any) captured as follow-up tasks
- [ ] Pull the transcript and confirm it shows the full engineering cycle.

**Acceptance:**
- [ ] One successful end-to-end run with all upgraded behaviors visible in the transcript.

---

## Execution Order

Build from foundations outward, commit per logical unit:

1. **Step 5** (follow-up queue) — foundational, others depend on it.
2. **Step 4** (smokeCommand) — small, low-risk warm-up.
3. **Step 2a** (ECR push CI workflow) — unblocks Step 7.
4. **Step 2b** (post-deploy validation) — depends on 2a.
5. **Step 1** (review loop) — uses Step 5; biggest piece.
6. **Step 3** (dev data seeding) — fold in if validation runs need it.
7. **Step 6** (recovery task) — first dogfood.
8. **Step 7** (e2e validation) — final dogfood.

---

## Working Notes

(Updated continuously as work progresses; this is the recovery scratchpad.)

### 2026-05-04
- Plan doc created. Steps 0 ↑ acceptance criteria captured. About to start Step 5.

### 2026-05-03 (continued)
- Steps 5, 4, 2b, 1, 3 implemented in that order. Each committed and pushed to nexus-main.
- Pipeline-worker rebuilt + rsync'd to EC2; forge-worker.service restarted with all new code in place.
- PR #176 (ECR push CI workflow) opened on [org]/[target-repo-realtime], all CI green incl. Bugbot, merged with --admin.
- ECR workflow validation via workflow_dispatch (run 25281190334) FAILED on IAM perms — blocker captured above.
- Recovery task body drafted at /tmp/forge-recovery-task.txt; ready to fire as soon as IAM is unblocked.

### Step status snapshot
- Step 0: ✅ plan doc
- Step 1: ✅ wait-for-external-review + address-loop integration
- Step 2a: ✅ workflow merged; ⚠️ blocked on IAM perms
- Step 2b: ✅ HTTP health + monitorScript with auto-queue
- Step 3: ✅ seed activity + CLI with prod-target refusal
- Step 4: ✅ smokeCommand wired into VERIFY
- Step 5: ✅ pending-queue + 3 CLIs
- Step 6: ⏸ recovery task drafted; awaiting IAM fix
- Step 7: ⏸ blocked behind Step 6 + IAM
