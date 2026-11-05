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

export type MarketSubject =
  | { kind: "HKO"; targetDate: string }
  | { kind: "SYNTHETIC"; sport: "BASKETBALL" | "FOOTBALL"; matchId: string; teamA: string; teamB: string }
  | { kind: "CUSTOM"; sourceName: string; sourceUrl: string; procedure: string; targetDate: string | null }
  | { kind: "UNRECOGNIZED" };

export const PUBLIC_METRICS = ["TOTAL_RAINFALL", "DAILY_MAX_TEMPERATURE"] as const;

export interface MarketData {
  id: number;
  view: MarketView;
  metric: { id: number; code: string; unit: string; valueStep: number; allowsTrace: boolean };
  subject: MarketSubject;
  official: boolean;
  condition: { comparison: number; lower: bigint; upper: bigint };
  proposer: string;
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

export function marketsFrom(dep: MetricDeployment, dashboard: Dashboard): MarketData[] {
  const all = dashboard.markets.map((view) => toMarketData(dep, view));
  const shown = isLocalMock(dep)
    ? all
    : all.filter((m) => m.subject.kind === "CUSTOM" || (m.subject.kind === "HKO" && (PUBLIC_METRICS as readonly string[]).includes(m.metric.code)));
  const newest = shown.reverse();
  const last = (m: MarketData) => m.subject.kind === "SYNTHETIC" || m.subject.kind === "UNRECOGNIZED";
  return [...newest.filter((m) => m.official), ...newest.filter((m) => !m.official && !last(m)), ...newest.filter(last)];
}

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
export function metricNameOf(code: string): string {
  const key = METRIC_KEYS[code];
  return key ? t(key) : code.replaceAll("_", " ");
}

export function formatReading(value: bigint | number, metric: { valueStep: number }): string {
  const v = BigInt(value);
  if (metric.valueStep % 100 === 0 && v % 100n === 0n) return (v / 100n).toString();
  return formatFixed100(v);
}

const SYMBOLS = ["", "<", "≤", ">", "≥"];

export function conditionOf(m: Pick<MarketData, "condition" | "metric">): string {
  return conditionText(m, "");
}

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

export function dayOf(yyyymmdd: string): string {
  const month = Number(yyyymmdd.slice(4, 6));
  const day = Number(yyyymmdd.slice(6, 8));
  if (activeLocale() === "zh-CN") return `${month}月${day}日`;
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] ?? "?";
  return `${day} ${name}`;
}

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

export type QuestionInput = Pick<MarketData, "subject" | "metric" | "condition" | "times">;

export function questionOf(m: QuestionInput): string {
  const cond = conditionWithUnitOf(m);
  const s = m.subject;
  if (s.kind === "HKO" && m.metric.code === "TOTAL_RAINFALL") return t("q.rain", { date: dayOf(s.targetDate), cond });
  if (s.kind === "HKO" && m.metric.code === "DAILY_MAX_TEMPERATURE") return t("q.temp", { date: dayOf(s.targetDate), cond });
  if (s.kind === "SYNTHETIC") return t(m.metric.code === "GOAL_MARGIN" ? "q.goal" : "q.score", { a: s.teamA, b: s.teamB, cond });
  if (s.kind === "CUSTOM") {
    const metric = metricNameOf(m.metric.code);
    const gap = /[\u3400-\u9fff]$/.test(metric) ? "" : " ";
    return t(m.condition.comparison === 5 ? "q.customRange" : "q.custom", { metric, gap, cond, window: windowOf(m) });
  }
  return t("q.metric", { metric: metricNameOf(m.metric.code), cond });
}

export function hkoFieldMarketOf(m: MarketData): HkoDailyExtractField | undefined {
  return m.subject.kind === "CUSTOM" && m.subject.targetDate ? hkoFieldOf(m.view.metric) : undefined;
}

export function sourceOf(m: MarketData): string {
  if (m.subject.kind === "HKO" || hkoFieldMarketOf(m)) return t("source.hko");
  if (m.subject.kind === "CUSTOM") return m.subject.sourceName;
  if (m.subject.kind === "SYNTHETIC") return t("source.synthetic");
  return t("source.unrecognized");
}

export type MarketTag = "official" | "custom" | "demo";
export function marketTagOf(m: MarketData): MarketTag | null {
  if (m.official) return "official";
  if (m.subject.kind === "SYNTHETIC") return "demo";
  return m.subject.kind === "CUSTOM" ? "custom" : null;
}

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

export function metricShortOf(code: string): string {
  const key = SHORT_KEYS[code];
  return key ? t(key) : code.replaceAll("_", " ");
}

export function shortLabelOf(m: MarketData): string {
  return `${windowOf(m)} ${metricShortOf(m.metric.code)} ${conditionOf(m)}`;
}

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

const KIND_WORDS: [RegExp, MetricKind][] = [[/RAIN/, "rain"], [/TEMP/, "heat"], [/HUMID|DEW/, "humidity"]];

export function metricKindOf(code: string): MetricKind {
  return KINDS[code] ?? KIND_WORDS.find(([word]) => word.test(code))?.[1] ?? "custom";
}
