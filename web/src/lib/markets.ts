// The interface's view of a market, read from the numeric client's Dashboard (web/src/metric/client.ts). Every
// field comes from chain reads at the dashboard's block. The question text is built from the registered metric,
// the market's condition and the rules document, after that document has been checked against the chain. The
// free-text title in the rules is never shown as the question.

import { ZeroAddress, ZeroHash } from "ethers";
import { formatFixed100 } from "@shared/metric/fixed100";
import { type HkoDailyExtractField, assertCustomNumericProfile, hkoFieldOf, isCustomNumericRules } from "@shared/metric/custom-profile";
import { assertHkoNumericProfile, assertSportsNumericProfile, isOfficialMetric } from "@shared/metric/numeric-profiles";
import { assertNumericMarketRulesMatchChain } from "@shared/metric/numeric-rules";
import { type Dashboard, type MarketView, type MetricDeployment, numericContextForMarket } from "../metric/client";
import { type MessageKey, activeLocale, t } from "../i18n";
import { REFUND_REASONS, TERMINALS, displayPhase, type DisplayPhase, type PhaseTimes, type RefundReason, type Terminal } from "./phase";
import { formatHktClock } from "./time";

export type Side = "YES" | "NO";
export type ReadingKind = "NUMERIC" | "TRACE";

/** The real-world subject named by the market's rules. */
export type MarketSubject =
  | { kind: "HKO"; targetDate: string }
  /** A sports demo: an ordered matchup whose result is a labelled synthetic file. The local chain only. */
  | { kind: "SYNTHETIC"; sport: "BASKETBALL" | "FOOTBALL"; matchId: string; teamA: string; teamB: string }
  /** A custom market: the source, its link and the reading procedure its creator committed. A day for an HKO field. */
  | { kind: "CUSTOM"; sourceName: string; sourceUrl: string; procedure: string; targetDate: string | null }
  | { kind: "UNRECOGNIZED" };

/** The official Observatory metrics a public network shows next to custom markets. */
export const PUBLIC_METRICS = ["TOTAL_RAINFALL", "DAILY_MAX_TEMPERATURE"] as const;

export interface MarketData {
  id: number;
  /** The client's record, for the result, dispute and settlement panels. */
  view: MarketView;
  /** valueStep is the registered reading step, fixed-point ×100 (100 means whole units). */
  metric: { id: number; code: string; unit: string; valueStep: number; allowsTrace: boolean };
  subject: MarketSubject;
  /** One of the long-term official metrics (rainfall, maximum temperature) under the official HKO rules. */
  official: boolean;
  /** Comparison 1 <, 2 ≤, 3 >, 4 ≥, 5 inclusive range. Bounds are fixed-point ×100 integers. */
  condition: { comparison: number; lower: bigint; upper: bigint };
  proposer: string;
  /** Hong Kong day (YYYYMMDD) the observation covers: the rules' target date for HKO markets. */
  targetDate: string;
  times: PhaseTimes;
  yesTotal: bigint;
  noTotal: bigint;
  total: bigint;
  paidOut: bigint;
  yesAccounts: number;
  noAccounts: number;
  terminal: Terminal;
  effective: Terminal;
  refundReason: RefundReason;
  assertion: {
    id: string;
    kind: ReadingKind;
    value: bigint;
    rawSha256: string;
    proposedAt: bigint;
    disputed: boolean;
    returned: boolean;
    rejected: boolean;
  } | null;
  uma: {
    expirationTime: bigint;
    settled: boolean;
    disputer: string | null;
    bond: bigint;
    asserter: string;
    /** Settlement readiness: by time on the local Mock without a dispute, else the client's check. */
    byTime: boolean;
    ready: boolean;
  } | null;
  position: { side: Side | null; stake: bigint; claimed: boolean };
  claimable: bigint;
}

const SIDES: Array<Side | null> = [null, "YES", "NO"];

export const isLocalMock = (dep: MetricDeployment) => dep.environment === "LOCAL_MOCK" && dep.chainId === 31337;

function subjectOf(view: MarketView): MarketSubject {
  try {
    const rules = assertNumericMarketRulesMatchChain(view.rulesDocument, numericContextForMarket(view));
    if (isCustomNumericRules(rules)) {
      const custom = assertCustomNumericProfile(rules);
      return { kind: "CUSTOM", sourceName: custom.sourceName, sourceUrl: custom.sourceUrl, procedure: custom.procedure, targetDate: custom.hko?.targetDate ?? null };
    }
    if (rules.synthetic) {
      const sports = assertSportsNumericProfile(rules);
      return { kind: "SYNTHETIC", sport: sports.sport, matchId: sports.matchId, teamA: sports.teamA, teamB: sports.teamB };
    }
    return { kind: "HKO", targetDate: assertHkoNumericProfile(rules).targetDate };
  } catch (error) {
    // Rules that do not match the chain or a supported profile are shown as unrecognized, never guessed.
    if (error instanceof Error) return { kind: "UNRECOGNIZED" };
    throw error;
  }
}

const hkDay = (unix: bigint) => new Date((Number(unix) + 8 * 3_600) * 1000).toISOString().slice(0, 10).replaceAll("-", "");

export function toMarketData(dep: MetricDeployment, view: MarketView): MarketData {
  const c = view.config;
  const subject = subjectOf(view);
  const a = view.assertion;
  const oa = view.oracleAssertion;
  const local = isLocalMock(dep);
  return {
    id: view.id,
    view,
    metric: { id: view.metric.id, code: view.metric.code, unit: view.metric.unit, valueStep: view.metric.valueStep, allowsTrace: view.metric.allowsTrace },
    subject,
    official: subject.kind === "HKO" && isOfficialMetric(view.metric),
    condition: { comparison: Number(c.condition.comparison), lower: BigInt(c.condition.lower), upper: BigInt(c.condition.upper) },
    proposer: c.proposer,
    targetDate: subject.kind === "HKO" ? subject.targetDate : subject.kind === "CUSTOM" && subject.targetDate ? subject.targetDate : hkDay(c.times.observationStart),
    times: {
      openAt: c.times.openAt,
      closeAt: c.times.closeAt,
      observationStart: c.times.observationStart,
      observationEnd: c.times.observationEnd,
      earliestAssertionAt: c.times.earliestAssertionAt,
      proposalCutoff: c.times.proposalCutoff,
      refundAt: c.times.refundAt,
      assertionLiveness: c.times.assertionLiveness,
    },
    yesTotal: view.state.yesTotal,
    noTotal: view.state.noTotal,
    total: view.state.yesTotal + view.state.noTotal,
    paidOut: view.state.paidOut,
    yesAccounts: Number(view.state.yesAccounts),
    noAccounts: Number(view.state.noAccounts),
    terminal: TERMINALS[Number(view.state.terminal)] ?? "UNRESOLVED",
    effective: TERMINALS[Number(view.effectiveTerminal)] ?? "UNRESOLVED",
    refundReason: REFUND_REASONS[Number(view.effectiveRefundReason)] ?? "NONE",
    assertion:
      a.assertionId === ZeroHash
        ? null
        : {
            id: a.assertionId,
            kind: a.reading.kind === 2n ? "TRACE" : "NUMERIC",
            value: a.reading.value,
            rawSha256: a.rawSha256,
            proposedAt: a.proposedAt,
            disputed: a.disputed,
            returned: a.returned,
            rejected: a.rejected,
          },
    uma: oa
      ? {
          expirationTime: oa.expirationTime,
          settled: oa.settled,
          disputer: oa.disputer === ZeroAddress ? null : oa.disputer,
          bond: oa.bond,
          asserter: oa.asserter,
          byTime: local && !a.disputed,
          ready: local ? a.disputed && view.mockResolutionReady : view.settlementReady === true,
        }
      : null,
    position: { side: SIDES[Number(view.position.side)] ?? null, stake: view.position.stake, claimed: view.position.claimed },
    claimable: view.claimable,
  };
}

/**
 * The markets this deployment shows: official metrics first, then the other weather markets, then the sports demos
 * and unrecognized rules, each newest first. A public network shows only official and custom markets. Sports demos
 * and unrecognized rules appear on the local chain only.
 */
export function marketsFrom(dep: MetricDeployment, dashboard: Dashboard): MarketData[] {
  const all = dashboard.markets.map((view) => toMarketData(dep, view));
  const shown = isLocalMock(dep)
    ? all
    : all.filter((m) => m.subject.kind === "CUSTOM" || (m.subject.kind === "HKO" && (PUBLIC_METRICS as readonly string[]).includes(m.metric.code)));
  const newest = shown.reverse();
  const last = (m: MarketData) => m.subject.kind === "SYNTHETIC" || m.subject.kind === "UNRECOGNIZED";
  return [...newest.filter((m) => m.official), ...newest.filter((m) => !m.official && !last(m)), ...newest.filter(last)];
}

/** Busier first: more staked, then more accounts, then the sooner close. */
export function byActivity(a: MarketData, b: MarketData): number {
  if (a.total !== b.total) return a.total > b.total ? -1 : 1;
  const accounts = b.yesAccounts + b.noAccounts - (a.yesAccounts + a.noAccounts);
  if (accounts !== 0) return accounts;
  return a.times.closeAt < b.times.closeAt ? -1 : a.times.closeAt > b.times.closeAt ? 1 : 0;
}

export function phaseOf(m: MarketData, now: bigint): DisplayPhase {
  return displayPhase(
    {
      times: m.times,
      terminal: m.terminal,
      effective: m.effective,
      assertion: m.assertion ? { disputed: m.assertion.disputed, rejected: m.assertion.rejected } : null,
      uma: m.uma ? { settled: m.uma.settled, settleReady: m.uma.byTime ? now >= m.uma.expirationTime : m.uma.ready } : null,
    },
    now,
  );
}

const UNIT_KEYS: Record<string, MessageKey> = { mm: "unit.mm", degC: "unit.degC", points: "unit.points", goals: "unit.goals" };
export function unitOf(unit: string): string {
  const key = UNIT_KEYS[unit];
  return key ? t(key) : unit;
}

const METRIC_KEYS: Record<string, MessageKey> = {
  TOTAL_RAINFALL: "metric.TOTAL_RAINFALL",
  DAILY_MAX_TEMPERATURE: "metric.DAILY_MAX_TEMPERATURE",
  DAILY_MIN_TEMPERATURE: "metric.DAILY_MIN_TEMPERATURE",
  DAILY_MEAN_TEMPERATURE: "metric.DAILY_MEAN_TEMPERATURE",
  DAILY_MEAN_HUMIDITY: "metric.DAILY_MEAN_HUMIDITY",
  DAILY_MEAN_PRESSURE: "metric.DAILY_MEAN_PRESSURE",
  DAILY_MEAN_DEW_POINT: "metric.DAILY_MEAN_DEW_POINT",
  DAILY_MEAN_CLOUD: "metric.DAILY_MEAN_CLOUD",
  SCORE_MARGIN: "metric.SCORE_MARGIN",
  GOAL_MARGIN: "metric.GOAL_MARGIN",
};
/** A known metric's name in the interface language. Any other registered code as written, with spaces. */
export function metricNameOf(code: string): string {
  const key = METRIC_KEYS[code];
  return key ? t(key) : code.replaceAll("_", " ");
}

/**
 * A fixed-point ×100 reading. A metric registered in whole units (a step that is a multiple of 1.00, such as points,
 * goals or whole percent) shows whole values without decimals. Any other metric shows at least one decimal.
 */
export function formatReading(value: bigint | number, metric: { valueStep: number }): string {
  const v = BigInt(value);
  if (metric.valueStep % 100 === 0 && v % 100n === 0n) return (v / 100n).toString();
  return formatFixed100(v);
}

const SYMBOLS = ["", "<", "≤", ">", "≥"];

/** "≥ 1.0", or the inclusive range "介于 1.0 与 5.0 之间（含两端）" / "between 1.0 and 5.0 (inclusive)", without the unit. */
export function conditionOf(m: Pick<MarketData, "condition" | "metric">): string {
  return conditionText(m, "");
}

/** The condition with its unit, as questions and rules show it: "≥ 1.0 mm", "between 70 and 85 % (inclusive)". */
export function conditionWithUnitOf(m: Pick<MarketData, "condition" | "metric">): string {
  return conditionText(m, unitOf(m.metric.unit));
}

function conditionText(m: Pick<MarketData, "condition" | "metric">, unit: string): string {
  const { comparison, lower, upper } = m.condition;
  const withUnit = (value: string) => (!unit ? value : unit === "%" ? `${value}%` : `${value} ${unit}`);
  const low = formatReading(lower, m.metric);
  // The contract's RANGE includes both ends: lower ≤ reading ≤ upper.
  if (comparison === 5) return t("cond.range", { lower: withUnit(low), upper: withUnit(formatReading(upper, m.metric)) });
  return withUnit(`${SYMBOLS[comparison] ?? "?"} ${low}`);
}

/** "11月3日" / "3 Nov" for a YYYYMMDD day. */
export function dayOf(yyyymmdd: string): string {
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (activeLocale() === "zh-CN") return `${month}月${day}日`;
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] ?? "?";
  return `${day} ${name}`;
}

/** The observation window in Hong Kong time: "11月5日", "11月2日至11月8日" or "11月5日 14:00–17:00" / "5 Nov 14:00–17:00". */
export function windowOf(m: Pick<MarketData, "times">): string {
  const { observationStart: start, observationEnd: end } = m.times;
  const day = hkDay;
  const midnight = (unix: bigint) => (unix + 8n * 3_600n) % 86_400n === 0n;
  if (midnight(start) && midnight(end)) {
    const last = day(end - 1n);
    return last === day(start) ? dayOf(last) : t("window.days", { from: dayOf(day(start)), to: dayOf(last) });
  }
  if (day(start) === day(end)) return t("window.hours", { date: dayOf(day(start)), from: formatHktClock(start), to: formatHktClock(end) });
  return t("window.span", { from: `${dayOf(day(start))} ${formatHktClock(start)}`, to: `${dayOf(day(end))} ${formatHktClock(end)}` });
}

/** What a question needs. The new-market preview builds one before the market exists. */
export type QuestionInput = Pick<MarketData, "subject" | "metric" | "condition" | "times">;

/** The market's question, from chain data and checked rules. */
export function questionOf(m: QuestionInput): string {
  const cond = conditionWithUnitOf(m);
  const s = m.subject;
  if (s.kind === "HKO" && m.metric.code === "TOTAL_RAINFALL") return t("q.rain", { date: dayOf(s.targetDate), cond });
  if (s.kind === "HKO" && m.metric.code === "DAILY_MAX_TEMPERATURE") return t("q.temp", { date: dayOf(s.targetDate), cond });
  if (s.kind === "SYNTHETIC") return t(m.metric.code === "GOAL_MARGIN" ? "q.goal" : "q.score", { a: s.teamA, b: s.teamB, cond });
  if (s.kind === "CUSTOM") {
    const metric = metricNameOf(m.metric.code);
    // "日平均相对湿度介于…" runs on. A Latin name keeps a space before the Chinese: "INDEX 介于…".
    const gap = /[\u3400-\u9fff]$/.test(metric) ? "" : " ";
    return t(m.condition.comparison === 5 ? "q.customRange" : "q.custom", { metric, gap, cond, window: windowOf(m) });
  }
  return t("q.metric", { metric: metricNameOf(m.metric.code), cond });
}

/** A custom market on one of HKO's Daily Extract fields: its known definition, so the interface can say it in the
 * reader's language. Other custom markets show their creator's text as written. */
export function hkoFieldMarketOf(m: MarketData): HkoDailyExtractField | undefined {
  return m.subject.kind === "CUSTOM" && m.subject.targetDate ? hkoFieldOf(m.view.metric) : undefined;
}

/** Where the result comes from, as shown next to the question. */
export function sourceOf(m: MarketData): string {
  if (m.subject.kind === "HKO" || hkoFieldMarketOf(m)) return t("source.hko");
  if (m.subject.kind === "CUSTOM") return m.subject.sourceName;
  if (m.subject.kind === "SYNTHETIC") return t("source.synthetic");
  return t("source.unrecognized");
}

/** The label next to a market's phase: official metric, custom market or sports demo. */
export type MarketTag = "official" | "custom" | "demo";
export function marketTagOf(m: MarketData): MarketTag | null {
  if (m.official) return "official";
  if (m.subject.kind === "SYNTHETIC") return "demo";
  return m.subject.kind === "CUSTOM" ? "custom" : null;
}

/** A sports demo on synthetic results. Weather markets come before it wherever one market is picked. */
export const isDemo = (m: Pick<MarketData, "subject">) => m.subject.kind === "SYNTHETIC";

const SHORT_KEYS: Record<string, MessageKey> = {
  TOTAL_RAINFALL: "metricShort.TOTAL_RAINFALL",
  DAILY_MAX_TEMPERATURE: "metricShort.DAILY_MAX_TEMPERATURE",
  DAILY_MIN_TEMPERATURE: "metricShort.DAILY_MIN_TEMPERATURE",
  DAILY_MEAN_TEMPERATURE: "metricShort.DAILY_MEAN_TEMPERATURE",
  DAILY_MEAN_HUMIDITY: "metricShort.DAILY_MEAN_HUMIDITY",
  DAILY_MEAN_PRESSURE: "metricShort.DAILY_MEAN_PRESSURE",
  DAILY_MEAN_DEW_POINT: "metricShort.DAILY_MEAN_DEW_POINT",
  DAILY_MEAN_CLOUD: "metricShort.DAILY_MEAN_CLOUD",
  SCORE_MARGIN: "metricShort.SCORE_MARGIN",
  GOAL_MARGIN: "metricShort.GOAL_MARGIN",
};

/** The metric's short name: 雨量 / Rain. Another registered code as written, with spaces. */
export function metricShortOf(code: string): string {
  const key = SHORT_KEYS[code];
  return key ? t(key) : code.replaceAll("_", " ");
}

/** "11月3日 雨量 ≥ 1.0": the compact name in dense lists and cards. */
export function shortLabelOf(m: MarketData): string {
  return `${dayOf(m.targetDate)} ${metricShortOf(m.metric.code)} ${conditionOf(m)}`;
}

/** A metric's type: one icon, one accent colour (CSS `data-metric`) and one filter chip each. Sports come last. */
export type MetricKind = "rain" | "heat" | "humidity" | "custom" | "sport";

const KINDS: Record<string, MetricKind> = {
  TOTAL_RAINFALL: "rain",
  DAILY_MAX_TEMPERATURE: "heat",
  DAILY_MIN_TEMPERATURE: "heat",
  DAILY_MEAN_TEMPERATURE: "heat",
  DAILY_MEAN_DEW_POINT: "humidity",
  DAILY_MEAN_HUMIDITY: "humidity",
  SCORE_MARGIN: "sport",
  GOAL_MARGIN: "sport",
};

export function metricKindOf(code: string): MetricKind {
  return KINDS[code] ?? "custom";
}
