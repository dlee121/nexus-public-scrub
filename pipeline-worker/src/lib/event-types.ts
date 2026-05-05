/**
 * Wire format for events flowing from this package into the forge-console.
 *
 * MUST stay structurally aligned with forge-console/src/event-types.ts —
 * this is a copy. Single source of truth would require a shared package.
 * If you change a field here, mirror it there.
 */

export type ForgePhase = 'implement' | 'verify' | 'patrol' | 'review' | 'address-review';

export interface ForgeEvent {
  workflowId: string;
  ticketId?: string;
  phase?: ForgePhase;
  activityId?: string;
  ts: string;
  kind: string;
  payload: unknown;
}
