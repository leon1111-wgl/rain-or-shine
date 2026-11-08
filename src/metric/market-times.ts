// The eight market times, checked as PredictionMarket.createMarket checks them. Each broken rule has one problem code.
// The module also has the window presets for the creation forms and the operator script.
// Times are Unix seconds. Hong Kong time is UTC+08:00 without daylight saving. The contract still runs its own checks.

import { hkDayWindow } from "../weather/profile.js";

/** PredictionMarket.MIN_LIVENESS and MIN_SETTLE_WINDOW, in seconds. */
export const MIN_ASSERTION_LIVENESS = 60;
export const MIN_SETTLE_WINDOW = 3600;

export interface MarketTimes {
  openAt: number;
  closeAt: number;
  observationStart: number;
  observationEnd: number;
  earliestAssertionAt: number;
  proposalCutoff: number;
  refundAt: number;
  assertionLiveness: number;
}

export const MARKET_TIME_KEYS = [
  "openAt", "closeAt", "observationStart", "observationEnd",
  "earliestAssertionAt", "proposalCutoff", "refundAt", "assertionLiveness",
] as const satisfies ReadonlyArray<keyof MarketTimes>;

export type MarketTimeProblem =
  | "NOT_WHOLE_SECONDS"
  | "OPENS_IN_PAST"
  | "CLOSES_BEFORE_OPEN"
  | "OBSERVES_BEFORE_CLOSE"
  | "EMPTY_OBSERVATION"
  | "PROPOSES_BEFORE_OBSERVATION_ENDS"
  | "EMPTY_PROPOSAL_WINDOW"
  | "REFUNDS_BEFORE_CUTOFF"
  | "LIVENESS_TOO_SHORT"
  | "SETTLE_WINDOW_TOO_SHORT";

const MESSAGES: Record<MarketTimeProblem, string> = {
  NOT_WHOLE_SECONDS: "every time must be a positive whole number of seconds",
  OPENS_IN_PAST: "betting must not open before the chain's current time",
  CLOSES_BEFORE_OPEN: "betting must close after it opens",
  OBSERVES_BEFORE_CLOSE: "the observation must not start before betting closes",
  EMPTY_OBSERVATION: "the observation must end after it starts",
  PROPOSES_BEFORE_OBSERVATION_ENDS: "results must not be accepted before the observation ends",
  EMPTY_PROPOSAL_WINDOW: "the last time to submit a result must be after the first",
  REFUNDS_BEFORE_CUTOFF: "the refund deadline must be after the last time to submit a result",
  LIVENESS_TOO_SHORT: `the challenge period must be at least ${MIN_ASSERTION_LIVENESS} seconds`,
  SETTLE_WINDOW_TOO_SHORT: `the refund deadline must leave the challenge period and ${MIN_SETTLE_WINDOW / 3600} hour to settle after the last time to submit a result`,
};

export function marketTimeMessage(problem: MarketTimeProblem): string {
  return MESSAGES[problem];
}

/**
 * Lists every rule the times break. `now` is the chain time for a new market.
 * Leave it out for an existing market. Its times must not depend on the current clock.
 */
export function marketTimeProblems(t: MarketTimes, now?: number): MarketTimeProblem[] {
  if (MARKET_TIME_KEYS.some((key) => !Number.isSafeInteger(t[key]) || t[key] <= 0)) return ["NOT_WHOLE_SECONDS"];
  const problems: MarketTimeProblem[] = [];
  if (now !== undefined && t.openAt < now) problems.push("OPENS_IN_PAST");
  if (t.closeAt <= t.openAt) problems.push("CLOSES_BEFORE_OPEN");
  if (t.observationStart < t.closeAt) problems.push("OBSERVES_BEFORE_CLOSE");
  if (t.observationEnd <= t.observationStart) problems.push("EMPTY_OBSERVATION");
  if (t.earliestAssertionAt < t.observationEnd) problems.push("PROPOSES_BEFORE_OBSERVATION_ENDS");
  if (t.proposalCutoff <= t.earliestAssertionAt) problems.push("EMPTY_PROPOSAL_WINDOW");
  if (t.refundAt <= t.proposalCutoff) problems.push("REFUNDS_BEFORE_CUTOFF");
  if (t.assertionLiveness < MIN_ASSERTION_LIVENESS) problems.push("LIVENESS_TOO_SHORT");
  // BigInt: a sum of three safe integers can leave the safe range.
  else if (BigInt(t.refundAt) < BigInt(t.proposalCutoff) + BigInt(t.assertionLiveness) + BigInt(MIN_SETTLE_WINDOW)) {
    problems.push("SETTLE_WINDOW_TOO_SHORT");
  }
  return problems;
}

export interface SettlementPlan {
  proposalWindow: number;
  assertionLiveness: number;
  refundBuffer: number;
}

/** The times for an observation window. By default, betting closes as the observation starts. */
export function windowMarketTimes(input: {
  openAt: number;
  observationStart: number;
  observationEnd: number;
  closeAt?: number;
  plan: SettlementPlan;
}): MarketTimes {
  const { plan } = input;
  const proposalCutoff = input.observationEnd + plan.proposalWindow;
  return {
    openAt: input.openAt,
    closeAt: input.closeAt ?? input.observationStart,
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    earliestAssertionAt: input.observationEnd,
    proposalCutoff,
    refundAt: proposalCutoff + plan.assertionLiveness + plan.refundBuffer,
    assertionLiveness: plan.assertionLiveness,
  };
}

/** One complete Hong Kong calendar day (YYYYMMDD). Betting closes one minute before the day. */
export function hkDayMarketTimes(input: { openAt: number; targetDate: string; plan: SettlementPlan }): MarketTimes {
  const window = hkDayWindow(input.targetDate);
  const start = Number(window.start);
  return windowMarketTimes({
    openAt: input.openAt, closeAt: start - 60, observationStart: start, observationEnd: Number(window.end), plan: input.plan,
  });
}
