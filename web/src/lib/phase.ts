// Display phases derived from on-chain reads. The contract decides (getEffectiveState). This module only names the
// phase for the views. It never invents a state the chain has not reached: REFUND_ELIGIBLE means "claim() would
// write the refund", not that a refund transaction happened.

export type Terminal = "UNRESOLVED" | "YES" | "NO" | "REFUND";
export type RefundReason = "NONE" | "EMPTY" | "SINGLE_SIDED" | "NO_VALID_SETTLEMENT";
export const TERMINALS: readonly Terminal[] = ["UNRESOLVED", "YES", "NO", "REFUND"];
export const REFUND_REASONS: readonly RefundReason[] = ["NONE", "EMPTY", "SINGLE_SIDED", "NO_VALID_SETTLEMENT"];

export interface PhaseTimes {
  openAt: bigint;
  closeAt: bigint;
  observationStart: bigint;
  observationEnd: bigint;
  earliestAssertionAt: bigint;
  proposalCutoff: bigint;
  refundAt: bigint;
  assertionLiveness: bigint;
}

export interface PhaseSnapshot {
  times: PhaseTimes;
  terminal: Terminal;
  effective: Terminal;
  assertion: { disputed: boolean; rejected: boolean } | null;
  uma: { settled: boolean; settleReady: boolean } | null;
}

export type DisplayPhase =
  | "SCHEDULED"
  | "OPEN"
  | "WAITING_OBSERVATION"
  | "WAITING_DATA"
  | "AWAITING_PROPOSAL"
  | "PROPOSED"
  | "DISPUTED"
  | "SETTLEABLE"
  | "REJECTED"
  | "NO_PROPOSAL"
  | "REFUND_ELIGIBLE"
  | "REFUND"
  | "RESOLVED_YES"
  | "RESOLVED_NO";

export type View = "detail" | "waiting" | "settlement";

export function displayPhase(s: PhaseSnapshot, now: bigint): DisplayPhase {
  if (s.effective === "YES") return "RESOLVED_YES";
  if (s.effective === "NO") return "RESOLVED_NO";
  if (s.effective === "REFUND") return s.terminal === "REFUND" ? "REFUND" : "REFUND_ELIGIBLE";
  const t = s.times;
  if (now < t.openAt) return "SCHEDULED";
  if (now < t.closeAt) return "OPEN";
  if (s.assertion) {
    if (s.assertion.rejected) return "REJECTED";
    if (s.uma && !s.uma.settled && s.uma.settleReady) return "SETTLEABLE";
    if (s.assertion.disputed) return "DISPUTED";
    return "PROPOSED";
  }
  if (now < t.observationEnd) return "WAITING_OBSERVATION";
  if (now < t.earliestAssertionAt) return "WAITING_DATA";
  if (now < t.proposalCutoff) return "AWAITING_PROPOSAL";
  return "NO_PROPOSAL";
}

export function viewOf(phase: DisplayPhase): View {
  if (phase === "SCHEDULED" || phase === "OPEN") return "detail";
  if (phase === "REFUND_ELIGIBLE" || phase === "REFUND" || phase === "RESOLVED_YES" || phase === "RESOLVED_NO") return "settlement";
  return "waiting";
}

export function waitingStep(phase: DisplayPhase): number {
  switch (phase) {
    case "SCHEDULED":
    case "OPEN":
      return 0;
    case "WAITING_OBSERVATION":
      return 1;
    case "WAITING_DATA":
    case "AWAITING_PROPOSAL":
    case "NO_PROPOSAL":
      return 2;
    case "PROPOSED":
    case "DISPUTED":
    case "REJECTED":
    case "SETTLEABLE":
      return 3;
    default:
      return 4;
  }
}

export function nextActions(phase: DisplayPhase): Array<"bet" | "propose" | "dispute" | "settle" | "claim"> {
  switch (phase) {
    case "OPEN":
      return ["bet"];
    case "AWAITING_PROPOSAL":
      return ["propose"];
    case "PROPOSED":
      return ["dispute"];
    case "SETTLEABLE":
      return ["settle"];
    case "REFUND_ELIGIBLE":
    case "REFUND":
    case "RESOLVED_YES":
    case "RESOLVED_NO":
      return ["claim"];
    default:
      return [];
  }
}
