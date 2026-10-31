import { describe, expect, it } from "vitest";
import {
  MIN_ASSERTION_LIVENESS, MIN_SETTLE_WINDOW, hkDayMarketTimes, marketTimeMessage, marketTimeProblems, windowMarketTimes,
  type MarketTimeProblem, type MarketTimes,
} from "../../src/metric/market-times.js";
import { hkDayWindow } from "../../src/weather/profile.js";

const NOW = 1_800_000_000;
const PLAN = { proposalWindow: 3_600, assertionLiveness: 120, refundBuffer: MIN_SETTLE_WINDOW };
const valid: MarketTimes = windowMarketTimes({ openAt: NOW + 60, observationStart: NOW + 3_660, observationEnd: NOW + 7_260, plan: PLAN });

describe("market times", () => {
  it("mirrors the contract's minimums", () => {
    expect([MIN_ASSERTION_LIVENESS, MIN_SETTLE_WINDOW]).toEqual([60, 3_600]);
  });

  it("accepts a window of any length that satisfies every rule, including equal boundaries", () => {
    expect(marketTimeProblems(valid, NOW)).toEqual([]);
    expect(valid).toEqual({
      openAt: NOW + 60, closeAt: NOW + 3_660, observationStart: NOW + 3_660, observationEnd: NOW + 7_260,
      earliestAssertionAt: NOW + 7_260, proposalCutoff: NOW + 10_860, refundAt: NOW + 10_860 + 120 + 3_600, assertionLiveness: 120,
    });
    const month = windowMarketTimes({ openAt: NOW, observationStart: NOW + 86_400, observationEnd: NOW + 31 * 86_400, plan: PLAN });
    expect(marketTimeProblems(month, NOW)).toEqual([]);
    expect(marketTimeProblems({ ...valid, openAt: NOW }, NOW)).toEqual([]);
  });

  it.each<[string, Partial<MarketTimes>, MarketTimeProblem]>([
    ["betting opens in the past", { openAt: NOW - 1 }, "OPENS_IN_PAST"],
    ["betting closes when it opens", { closeAt: NOW + 60 }, "CLOSES_BEFORE_OPEN"],
    ["the observation starts before betting closes", { observationStart: NOW + 3_659 }, "OBSERVES_BEFORE_CLOSE"],
    ["the observation is empty", { observationEnd: NOW + 3_660, earliestAssertionAt: NOW + 3_660 }, "EMPTY_OBSERVATION"],
    ["results are accepted before the observation ends", { earliestAssertionAt: NOW + 7_259 }, "PROPOSES_BEFORE_OBSERVATION_ENDS"],
    ["the proposal window is empty", { proposalCutoff: NOW + 7_260 }, "EMPTY_PROPOSAL_WINDOW"],
    ["refunds start at the cutoff", { refundAt: NOW + 10_860 }, "REFUNDS_BEFORE_CUTOFF"],
    ["the challenge period is under a minute", { assertionLiveness: 59 }, "LIVENESS_TOO_SHORT"],
    ["less than an hour is left to settle", { refundAt: NOW + 10_860 + 120 + 3_599 }, "SETTLE_WINDOW_TOO_SHORT"],
    ["a time is not a whole second", { closeAt: NOW + 3_660.5 }, "NOT_WHOLE_SECONDS"],
  ])("reports %s", (_name, change, problem) => {
    const problems = marketTimeProblems({ ...valid, ...change }, NOW);
    expect(problems).toContain(problem);
    expect(marketTimeMessage(problem)).toMatch(/\w/);
  });

  it("leaves out the current time for an existing market", () => {
    expect(marketTimeProblems({ ...valid, openAt: NOW - 86_400 })).toEqual([]);
  });

  it("covers one complete Hong Kong day and closes betting a minute before it", () => {
    const times = hkDayMarketTimes({ openAt: NOW, targetDate: "20270120", plan: PLAN });
    const window = hkDayWindow("20270120");
    expect([times.observationStart, times.observationEnd, times.closeAt]).toEqual([Number(window.start), Number(window.end), Number(window.start) - 60]);
    expect(marketTimeProblems(times, NOW)).toEqual([]);
  });
});
