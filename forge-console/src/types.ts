// Wire types shared between server routes and the HTML frontend.
// Kept here (not imported from pipeline-worker) so this package is freestanding.

export type WorkflowBucket = 'needsApproval' | 'running' | 'done' | 'failed';

export interface WorkflowCard {
  workflowId: string;
  state: string;
  ticketId: string;
  startTime: string | null;
  workflowType: string;
  /**
   * Workflow ID of this card's parent (multiTicketWorkflow), or null for
   * top-level entries. Sourced from `parentExecution` on the SDK list
   * item when available; falls back to a startTime-window heuristic when
   * the SDK doesn't surface parent linkage. The dashboard uses this to
   * render pipelineWorkflow children indented beneath their orchestrating
   * multiTicketWorkflow parent.
   */
  parentWorkflowId?: string | null;
  /**
   * Workflow-launch options snapshot (e.g. `{ skipProdDeploy: true }`).
   * Sourced via `currentOptionsQuery` on the worker. Older workflows
   * predating that handler omit this field. Empty object means options
   * were queryable but no flags were set.
   */
  options?: WorkflowOptionsCard;
}

/**
 * Wire shape of `WorkflowOptions` from the worker. Mirrors
 * `pipeline-worker/src/types.ts:WorkflowOptions` — kept local so this
 * package stays freestanding.
 */
export interface WorkflowOptionsCard {
  skipProdDeploy?: boolean;
}

export interface WorkflowsResponse {
  needsApproval: WorkflowCard[];
  running: WorkflowCard[];
  done: WorkflowCard[];
  failed: WorkflowCard[];
  refreshedAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  rationale?: string;
}

export interface Wave {
  wave: number;
  tickets: Ticket[];
}

export interface WavePlan {
  instruction: string;
  waves: Wave[];
}

/**
 * PR metadata exposed to the UI per pipelineWorkflow. Populated when the
 * workflow has reached PR_OPEN or beyond. Null until then. The `state`
 * field is fetched live from GitHub at detail-request time (PR can be
 * merged/closed after the workflow completes).
 */
export interface PrInfoCard {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  repoFullName: string;
  /** Live PR state from GitHub: "open" | "closed" | "merged". */
  state: 'open' | 'closed' | 'merged';
}

export interface WorkflowDetail extends WorkflowCard {
  plan: WavePlan | null;
  planFetchError: string | null;
  childWorkflowIds: string[];
  /** PR card; null for workflows that haven't reached PR_OPEN. */
  pr: PrInfoCard | null;
  /**
   * For workflows in a failure terminal state (BLOCKED / FAILED / CANCELLED /
   * TERMINATED / TIMED_OUT): the failure message extracted from the workflow
   * result. Null for successful or in-progress workflows. Best-effort —
   * extraction can fail if the SDK shape changes.
   */
  errorMessage: string | null;
}

export interface ActionResponse {
  ok: boolean;
  workflowId: string;
  signal?: string;
  action?: string;
  error?: string;
}
