import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  proxyActivities,
  log,
  workflowInfo,
  ApplicationFailure,
  CancelledFailure,
  isCancellation,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { Ticket, PipelineState, PrInfo, WorkflowOptions } from '../types';

// Signals — all defined at module scope.
export const dangerApprovedSignal = defineSignal('dangerApprovedSignal');
export const dangerRejectedSignal = defineSignal('dangerRejectedSignal');
export const coveredByCoalesceSignal = defineSignal<[string]>('coveredByCoalesceSignal');
export const deployCompletedSignal = defineSignal<['success' | 'failure']>('deployCompletedSignal');
// Prod-deploy gate. Operator clicks a button on the dashboard; the route
// sends one of these. `prodApprovedSignal` proceeds with the deploy;
// `prodRejectedSignal` skips prod and ends the workflow CLEANLY (DONE,
// not BLOCKED — rejecting prod is a valid outcome, not a failure).
export const prodApprovedSignal = defineSignal('prodApprovedSignal');
export const prodRejectedSignal = defineSignal('prodRejectedSignal');

// Queries — module-scope, must match handler registrations below.
export const currentStateQuery = defineQuery<PipelineState>('currentStateQuery');
export const currentPrQuery = defineQuery<PrInfo | null>('currentPrQuery');
/**
 * Workflow-launch options snapshot. Returned by the running workflow so
 * the dashboard can surface launch-time choices (e.g. skipProdDeploy)
 * without having to re-derive them from history. Always returns a
 * concrete object; absent options serialize as `{}` so the wire shape
 * is stable.
 */
export const currentOptionsQuery = defineQuery<WorkflowOptions>('currentOptionsQuery');
/**
 * Returns the absolute paths of every CC-session JSONL file produced
 * by this pipeline run, in chronological order (the order the workflow
 * spawned them). Consumed by the forge-console transcript endpoint.
 */
export const transcriptSessionsQuery = defineQuery<string[]>('transcriptSessionsQuery');

// startToCloseTimeout sits above the longest CC phase so Temporal observes
// a clean CC-side timeout (the activity returns with an Error) instead of
// racing into startToClose first, which would mark the activity as
// timed-out at the Temporal layer and trigger the retry policy below
// mid-flight. Implement raised to 90min, activity timeout sits 5min above.
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '95 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },
});

// Slack pings get a tighter timeout + fewer retries — they're best-effort
// observability, NOT correctness, and the worker shouldn't sit on a failing
// Slack call for 35 minutes. Failures here never propagate (the activity
// itself returns {ok:false} rather than throwing).
const slackActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '2s', backoffCoefficient: 2 },
});

// Prod-deploy gate gets its own activity options — it's a `condition()`
// inside the workflow, not an activity, but the runDeployActivity that
// follows can take longer than 35min on EB env updates.
//
// `heartbeatTimeout` is set so the activity is forced to heartbeat on
// the cadence runDeployActivity uses internally (every 30s during the
// deploy command). 90s = "one missed beat is tolerated, two trips the
// timeout and Temporal retries the activity." Without this, a hung
// deploy burns the full 60 min before Temporal notices.
const deployActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 minutes',
  heartbeatTimeout: '90 seconds',
  retry: { maximumAttempts: 2, initialInterval: '30s', backoffCoefficient: 2 },
});

export async function pipelineWorkflow(
  ticket: Ticket,
  planCritique: string = '',
  options: WorkflowOptions = {},
): Promise<void> {
  let state: PipelineState = 'QUEUED';
  let pr: PrInfo | null = null;
  let _dangerApproved = false;
  let _dangerRejected = false;
  let coveredBySha: string | null = null;
  let deployStatus: 'success' | 'failure' | null = null;
  let prodApproved = false;
  let prodRejected = false;
  // Append-only list of CC session JSONL paths produced by this run.
  // Activities (implement, review, address-review) push their session
  // file path on completion so the dashboard can reconstruct the full
  // narrative transcript when DK requests it.
  const transcriptSessions: string[] = [];

  setHandler(currentStateQuery, () => state);
  setHandler(currentPrQuery, () => pr);
  setHandler(currentOptionsQuery, () => ({ ...options }));
  setHandler(transcriptSessionsQuery, () => transcriptSessions.slice());
  setHandler(dangerApprovedSignal, () => { _dangerApproved = true; });
  setHandler(dangerRejectedSignal, () => { _dangerRejected = true; });
  setHandler(coveredByCoalesceSignal, (sha: string) => { coveredBySha = sha; });
  setHandler(deployCompletedSignal, (status: 'success' | 'failure') => { deployStatus = status; });
  setHandler(prodApprovedSignal, () => { prodApproved = true; });
  setHandler(prodRejectedSignal, () => { prodRejected = true; });

  try {
    // PLAN_REVIEW
    state = 'PLAN_REVIEW';
    log.info('Entering PLAN_REVIEW', { ticketId: ticket.id });
    const planReviewResult = await acts.planReviewActivity(
      `${ticket.title}\n\n${ticket.description}\n\nAcceptance criteria:\n${ticket.acceptanceCriteria.join('\n')}`,
    );

    // IMPLEMENT
    state = 'IMPLEMENT';
    log.info('Entering IMPLEMENT', { ticketId: ticket.id });
    await slackActs.notifySlackActivity({
      text: `🛠️ \`${ticket.id}\` — IMPLEMENT starting · ${ticket.title}`,
    });
    const implementResult = await acts.implementActivity(ticket, planCritique || planReviewResult);
    const { worktreePath, branchName } = implementResult;
    if (implementResult.sessionJsonlPath) transcriptSessions.push(implementResult.sessionJsonlPath);

    // VERIFY
    state = 'VERIFY';
    log.info('Entering VERIFY', { ticketId: ticket.id });
    await slackActs.notifySlackActivity({
      text: `🧪 \`${ticket.id}\` — VERIFY (lint + tests + GPT diff review)`,
    });
    const { diffReview } = await acts.verifyActivity({ ticket, worktreePath });

    // PR_OPEN
    state = 'PR_OPEN';
    log.info('Entering PR_OPEN', { ticketId: ticket.id });
    const { prNumber, prUrl, prTitle, repoFullName, headSha } = await acts.createPRActivity({
      ticket, worktreePath, branchName, diffReview,
    });
    pr = { prNumber, prUrl, prTitle, repoFullName, headSha };

    // Slack ping — PR is open, give DK the link. Best-effort: failures
    // logged but never propagated. Sent before CI_WAIT so DK can start
    // skimming the diff while CI runs.
    await slackActs.notifySlackActivity({
      text: [
        `🔥 *Forge opened a PR* — \`${ticket.id}\``,
        ``,
        `*${prTitle}*`,
        prUrl,
        ``,
        `Pipeline state: \`PR_OPEN\` → CI_WAIT next. I'll ping you again at the prod-deploy gate after merge.`,
      ].join('\n'),
    });

    // CI_WAIT
    state = 'CI_WAIT';
    log.info('Entering CI_WAIT', { ticketId: ticket.id, prNumber });
    let currentSha = headSha;
    await slackActs.notifySlackActivity({
      text: `🔍 \`${ticket.id}\` — CI_WAIT · waiting on required checks for PR #${prNumber}`,
    });
    const ciResult = await acts.ciWaitActivity({ prNumber, headSha: currentSha, repoName: ticket.repoName });
    if (ciResult === 'failure') {
      throw ApplicationFailure.nonRetryable(`CI failed for PR #${prNumber}`, 'CI_FAILED');
    }
    await slackActs.notifySlackActivity({
      text: `✅ \`${ticket.id}\` — CI passed on PR #${prNumber}`,
    });

    // REVIEW → ADDRESS_REVIEW → re-CI loop, hard-capped.
    //
    // Each iteration:
    //   1. Wait at least 3 min for external reviewers (Bugbot, humans,
    //      other bots) so we don't race past their feedback the way
    //      PRs #170/#173/#175 did. Capped at 8 min so the workflow
    //      can't be pinned indefinitely on a chatty PR thread.
    //   2. Run /review (Forge's own self-review). Combined with the
    //      external comments, this is the full feedback set.
    //   3. If anything to address, run addressReviewActivity with
    //      BOTH the self-review and external comments folded into one
    //      prompt. The session decides which items are in scope vs
    //      out of scope; out-of-scope items get queued to the
    //      pending-task queue and replied to on the PR thread.
    //   4. Push, re-CI, restart the loop.
    //
    // 5 cycles (10 Opus sessions per ticket) is enough headroom for
    // normal back-and-forth; beyond that a human has to step in.
    const MAX_ADDRESS_REVIEW_CYCLES = 5;
    let addressCycles = 0;
    while (true) {
      // Wait for external reviewers BEFORE running our own review.
      // This is the key behavioral change: PRs no longer merge inside
      // seconds of green CI.
      state = 'REVIEW';
      log.info('Entering external-review wait', { ticketId: ticket.id, prNumber, headSha: currentSha });
      const externalWait = await acts.waitForExternalReviewActivity({
        ticket,
        prNumber,
        headSha: currentSha,
      });

      log.info('Entering REVIEW', { ticketId: ticket.id, prNumber, addressCycles });
      const review = await acts.reviewActivity({ ticket, prNumber, worktreePath });
      if (review.sessionJsonlPath) transcriptSessions.push(review.sessionJsonlPath);

      // Combine all three feedback channels into a single packet:
      //
      //   1. The VERIFY-time GPT diff review JSON (issues / severity /
      //      summary). Generated during verifyActivity, embedded in the
      //      PR body; address-review never saw it before this commit.
      //      Non-critical findings would silently slip through to merge.
      //
      //   2. The /review skill comment (`### Code review` posted by the
      //      Forge bot during reviewActivity). Already plumbed.
      //
      //   3. External comments collected during waitForExternalReview
      //      (Bugbot's `failure`/`neutral` check-runs, human
      //      REQUEST_CHANGES, etc.). Already plumbed via listExternalComments.
      //
      // addressReview consumes this verbatim. Done before the
      // hasFeedback short-circuit so external reviewers can also gate
      // the merge — Forge's self-review saying "no issues" doesn't
      // override a Bugbot finding or a human REQUEST_CHANGES.
      const externalSection =
        externalWait.comments.length === 0
          ? '(no external comments collected during the review window)'
          : externalWait.comments
              .map((c) =>
                `--- [${c.source}] @${c.author} (${c.createdAt}) ---\n${c.body || '(empty body)'}`,
              )
              .join('\n\n');

      // VERIFY-time diff review has issues only when reviewObj.issues
      // is non-empty. Empty array / "verdict: pass" / no findings → skip
      // including it (it'd just be noise). Treat parse failures
      // defensively: if we can't parse, include the raw text so the
      // address session can still see it.
      let verifyDiffSection = '';
      let verifyHasIssues = false;
      try {
        const parsed = JSON.parse(diffReview);
        const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
        verifyHasIssues = issues.length > 0;
        if (verifyHasIssues) {
          verifyDiffSection =
            `=== Forge VERIFY-time GPT review (${issues.length} issue(s) flagged pre-PR-open) ===\n` +
            diffReview +
            `\n\n`;
        }
      } catch {
        // Couldn't parse — include the raw text. The model on the
        // address-review side can read it just fine.
        verifyDiffSection =
          `=== Forge VERIFY-time GPT review (raw; JSON parse failed) ===\n` +
          (diffReview || '(empty)') +
          `\n\n`;
        verifyHasIssues = (diffReview || '').trim().length > 0;
      }

      const combinedFeedback =
        verifyDiffSection +
        `=== Forge /review skill comment ===\n${review.commentBody || '(no self-review posted)'}\n\n` +
        `=== External comments (${externalWait.comments.length}) ===\n${externalSection}`;

      const externalHasFeedback = externalWait.comments.length > 0;
      const hasFeedback = review.hasIssues || externalHasFeedback || verifyHasIssues;
      if (!hasFeedback) break;

      if (addressCycles >= MAX_ADDRESS_REVIEW_CYCLES) {
        // ApplicationFailure (not plain Error) so Temporal terminates the
        // workflow with status FAILED instead of treating this as a
        // workflow-task crash and retrying it forever (which is exactly
        // what happened on 2026-05-03 with PR #177 — Bugbot's "no issues"
        // check-run summary kept driving cycles, hit the cap, threw plain
        // Error, and the workflow loop-retried with backoff for 30+ min
        // until DK noticed). nonRetryable + explicit type makes the
        // failure clean and queryable.
        throw ApplicationFailure.nonRetryable(
          `PR #${prNumber}: review still flagging issues after ${MAX_ADDRESS_REVIEW_CYCLES} address-review cycles. Manual intervention required.\n\n--- Combined feedback ---\n${combinedFeedback}`,
          'MAX_ADDRESS_REVIEW_CYCLES_EXCEEDED',
        );
      }

      addressCycles++;
      state = 'ADDRESS_REVIEW';
      log.info('Entering ADDRESS_REVIEW', {
        ticketId: ticket.id, prNumber, cycle: addressCycles,
        selfHasIssues: review.hasIssues, externalCount: externalWait.comments.length,
      });
      const addressed = await acts.addressReviewActivity({
        ticket, prNumber, worktreePath, branchName,
        reviewComment: combinedFeedback, cycle: addressCycles,
      });
      if (addressed.sessionJsonlPath) transcriptSessions.push(addressed.sessionJsonlPath);

      // Zero new commits → the address-review session decided every
      // finding was either accept-with-justification, false-positive,
      // or out-of-scope-and-queued (see addressReview.ts docstring).
      // No code change happened, no point re-running CI on the same
      // sha, no point looping again on the same feedback. Break out
      // and proceed to merge.
      if (addressed.newCommitCount === 0) {
        log.info(
          'addressReview produced no commits; treating as "feedback resolved without code changes" and proceeding to merge',
          { ticketId: ticket.id, prNumber, cycle: addressCycles },
        );
        await slackActs.notifySlackActivity({
          text: `📝 \`${ticket.id}\` — review feedback assessed; no code changes needed (cycle ${addressCycles})`,
        });
        break;
      }
      currentSha = addressed.headSha;

      state = 'CI_WAIT';
      log.info('Re-entering CI_WAIT after ADDRESS_REVIEW', {
        ticketId: ticket.id, prNumber, cycle: addressCycles,
        newHeadSha: currentSha, newCommitCount: addressed.newCommitCount,
      });
      const reCiResult = await acts.ciWaitActivity({
        prNumber, headSha: currentSha, repoName: ticket.repoName,
      });
      if (reCiResult === 'failure') {
        throw ApplicationFailure.nonRetryable(
          `CI failed for PR #${prNumber} after addressReview cycle ${addressCycles}`,
          'CI_FAILED_POST_ADDRESS_REVIEW',
        );
      }
      await slackActs.notifySlackActivity({
        text: `✅ \`${ticket.id}\` — CI re-passed after address-review cycle ${addressCycles}`,
      });
    }

    // MERGE_QUEUE (simplified: direct merge for Chunk 1; Merge Queue integration in Chunk 2+).
    state = 'MERGE_QUEUE';
    log.info('Entering MERGE_QUEUE / direct merge', { ticketId: ticket.id });
    const mergeSha = await acts.mergeActivity({ prNumber, repoName: ticket.repoName });
    await slackActs.notifySlackActivity({
      text: `🟣 \`${ticket.id}\` — PR #${prNumber} merged · ${mergeSha.slice(0, 12)}`,
    });

    // Resolve autoDeploy once; used by DEV_DEPLOY messaging and the
    // PROD_DEPLOY_GATE skip below.
    const repoNameForGate = ticket.repoName ?? '[target-repo-realtime]';
    const isAutoDeployRepo = await acts.isAutoDeployRepo({ repoName: repoNameForGate });

    // DEV_DEPLOY — the existing devDeployActivity already short-circuits
    // for repos with `autoDeploy: true` (e.g. [target-repo-web] on Render).
    state = 'DEV_DEPLOY';
    log.info('Entering DEV_DEPLOY', { ticketId: ticket.id, mergeSha });
    await slackActs.notifySlackActivity({
      text: isAutoDeployRepo
        ? `🚀 \`${ticket.id}\` — auto-deploy via merge (Forge skipped local deploy; the platform / CI owns it).`
        : `🚀 \`${ticket.id}\` — DEV_DEPLOY starting · ${mergeSha.slice(0, 12)}`,
    });
    if (coveredBySha) {
      state = 'WAIT_FOR_COVERING_DEPLOY';
      log.info('Waiting for covering deploy', { ticketId: ticket.id, coveredBySha });
      await condition(() => deployStatus !== null);
    } else {
      await acts.devDeployActivity({ mergeSha, repoName: ticket.repoName });
      deployStatus = 'success';
    }
    if ((deployStatus as 'success' | 'failure' | null) === 'failure') {
      throw ApplicationFailure.nonRetryable(
        'Deploy failed (signalled by coordinator)',
        'COORDINATED_DEPLOY_FAILED',
      );
    }
    if (!isAutoDeployRepo) {
      await slackActs.notifySlackActivity({
        text: `✅ \`${ticket.id}\` — DEV_DEPLOY complete`,
      });
    }
    // For autoDeploy repos we don't claim "complete" here — Render's
    // pipeline runs out-of-band. The trigger ping above is the
    // confirmation Forge owes; Render's dashboard owns finish status.

    // MONITOR — post-deploy validation. Opt-in per-repo via the
    // `monitorScript` config field; no-op success when unset. See
    // monitor.ts for the rationale on decoupling this from autoDeploy.
    state = 'MONITOR';
    log.info('Entering MONITOR', { ticketId: ticket.id });
    const monitorResult = await acts.monitorActivity({
      worktreePath,
      repoName: ticket.repoName,
      // Pass-through for the pending-queue follow-up task on failure
      // — gives the operator a back-pointer to this run + this PR.
      sourceWorkflowId: workflowInfo().workflowId,
      sourcePr: prUrl,
    });
    if (!monitorResult.passed) {
      throw ApplicationFailure.nonRetryable(
        `MONITOR validation failed:\n${monitorResult.output}`,
        'MONITOR_FAILED',
      );
    }

    // skipProdDeploy launch-time opt-out. Set when the workflow was
    // started for dogfooding / dev-only validation — the operator
    // explicitly chose at launch time to bypass the prod gate. Distinct
    // from prodRejectedSignal (an interactive choice at the gate);
    // skipProdDeploy means "don't even ping me, end here." After-MONITOR
    // semantics match the autoDeploy-repo branch: state=DONE, no
    // PROD_DEPLOY_GATE Slack ping.
    if (options.skipProdDeploy === true) {
      log.info('Skipping PROD_DEPLOY_GATE — skipProdDeploy=true at launch', {
        ticketId: ticket.id, prNumber,
      });
      await slackActs.notifySlackActivity({
        text: `🟢 \`${ticket.id}\` — pipeline DONE (prod deploy skipped at launch · skipProdDeploy=true). ${prUrl}`,
      });
      state = 'DONE';
      return;
    }

    // PROD_DEPLOY_GATE — block on operator approval via Slack.
    //
    // Why a gate: prod is irreversible at the application layer; even
    // with rollback tooling, accidentally pushing a bad release to prod
    // costs time and trust. DK approves explicitly each time.
    //
    // For repos with `autoDeploy: true` (Render): Render already pushed
    // to prod when main moved. Skip the gate AND the deploy step;
    // workflow ends after MONITOR with state=DONE.
    if (!isAutoDeployRepo) {
      state = 'PROD_DEPLOY_GATE';
      log.info('Entering PROD_DEPLOY_GATE', { ticketId: ticket.id, prNumber });

      // Slack the gate. Best-effort. The dashboard also surfaces the
      // gate, so a missed Slack ping doesn't strand the workflow —
      // DK can still approve from the UI.
      await slackActs.notifySlackActivity({
        text: [
          `🔥 *Forge prod-deploy gate* — \`${ticket.id}\``,
          ``,
          `Dev deploy succeeded for *${prTitle}* (${prUrl}). Awaiting your approval to push to prod.`,
          ``,
          `Repo: \`${repoFullName}\``,
          `Merge SHA: \`${mergeSha.slice(0, 12)}\``,
          ``,
          `Approve or reject from the Forge dashboard. (Reject = ship dev only, end workflow cleanly.)`,
        ].join('\n'),
      });

      // Block until the operator decides. A workflow cancellation while
      // we sit here surfaces as CancelledFailure in the outer catch and
      // ends the workflow with status CANCELLED — exactly right for
      // "operator gave up on this run".
      await condition(() => prodApproved || prodRejected);

      if (prodRejected) {
        log.info('Prod deploy rejected — ending workflow without prod push', { ticketId: ticket.id });
        await slackActs.notifySlackActivity({
          text: `🔥 \`${ticket.id}\` — prod deploy rejected. Dev deploy stays. Workflow complete.`,
        });
        state = 'DONE';
        return;
      }

      // PROD_DEPLOY
      state = 'PROD_DEPLOY';
      log.info('Entering PROD_DEPLOY', { ticketId: ticket.id, mergeSha });
      await slackActs.notifySlackActivity({
        text: `🚀 \`${ticket.id}\` — PROD_DEPLOY starting · ${mergeSha.slice(0, 12)}`,
      });
      await deployActs.runDeployActivity('prod', {
        ticketId: ticket.id,
        mergeSha,
        enqueuedAt: Date.now(),
        repoName: ticket.repoName,
      });

      await slackActs.notifySlackActivity({
        text: `✅ \`${ticket.id}\` — PROD_DEPLOY complete. ${prUrl}`,
      });
    } else {
      log.info('Skipping prod gate — autoDeploy repo handles prod via merge', {
        ticketId: ticket.id, repoName: repoNameForGate,
      });
    }

    state = 'DONE';
    log.info('Pipeline DONE', { ticketId: ticket.id });
    await slackActs.notifySlackActivity({
      text: `🎉 \`${ticket.id}\` — pipeline DONE · ${ticket.title}`,
    });

  } catch (err) {
    // Cancellation (operator clicked "reject" → handle.cancel) is NOT
    // a failure. Workflow returns cleanly with state=CANCELLED so the
    // dashboard shows it in the right bucket and Temporal records
    // status=CANCELLED rather than FAILED.
    if (isCancellation(err) || err instanceof CancelledFailure) {
      state = 'CANCELLED';
      log.info('Pipeline CANCELLED by operator', { ticketId: ticket.id });
      // Best-effort Slack ping. Don't await on a Slack call inside a
      // cancellation cleanup — Temporal's CancellationScope will swallow
      // further activity calls. So fire-and-forget by NOT awaiting; the
      // worker's outbound HTTP queue handles the rest.
      return;
    }

    state = 'BLOCKED';
    const errMsg = (err as Error).message;
    log.error('Pipeline BLOCKED', { ticketId: ticket.id, error: errMsg });

    // Slack the block — DK should know without watching the dashboard.
    // Best-effort: notifySlackActivity returns {ok:false} on any failure,
    // never throws, so this won't mask the original error.
    await slackActs.notifySlackActivity({
      text: [
        `🔥 *Forge pipeline BLOCKED* — \`${ticket.id}\``,
        ``,
        pr ? `PR: ${pr.prUrl}` : `(No PR opened — failed earlier in the pipeline.)`,
        ``,
        `Error: ${errMsg.slice(0, 800)}`,
        ``,
        `Check the Forge dashboard for full context.`,
      ].join('\n'),
    });

    throw err;
  }
}
