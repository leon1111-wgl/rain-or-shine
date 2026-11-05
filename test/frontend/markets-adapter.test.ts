import { ZeroHash, encodeBytes32String, keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import {
  HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument, identifierFromText,
  type CustomMetric,
} from "../../src/metric/custom-profile";
import { hkDayMarketTimes, windowMarketTimes, type MarketTimes } from "../../src/metric/market-times";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules, buildSportsNumericRules } from "../../src/metric/numeric-profiles";
import { hkDayWindow } from "../../src/weather/profile";
import { setActiveLocale } from "../../web/src/i18n";
import {
  conditionWithUnitOf, formatReading, isDemo, marketTagOf, marketsFrom, metricKindOf, metricNameOf, metricShortOf, phaseOf, questionOf, shortLabelOf, sourceOf, toMarketData, windowOf,
} from "../../web/src/lib/markets";
import type { Dashboard, MarketView, MetricDeployment } from "../../web/src/metric/client";

const PROPOSER = "0x00000000000000000000000000000000000000a1";
const local = { environment: "LOCAL_MOCK", chainId: 31337 } as MetricDeployment;
const sepolia = { environment: "SEPOLIA_UMA", chainId: 11155111 } as MetricDeployment;
const toBig = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));

interface Spec {
  id: number;
  code: string;
  comparison?: number;
  lower: number;
  targetDate?: string;
  yes?: bigint;
  no?: bigint;
  effective?: bigint;
  reason?: bigint;
  title?: string;
}

function view(spec: Spec): MarketView {
  const preset = NUMERIC_METRIC_PRESETS.find((p) => p.code === spec.code)!;
  const metricId = spec.code === "DAILY_MAX_TEMPERATURE" ? 2 : 1;
  const date = spec.targetDate ?? "20261103";
  const window = hkDayWindow(date);
  const end = Number(window.end);
  const times = { openAt: Number(window.start) - 86_400, closeAt: Number(window.start) - 60, observationStart: Number(window.start), observationEnd: end, earliestAssertionAt: end, proposalCutoff: end + 7 * 86_400, refundAt: end + 7 * 86_400 + 7_200 + 3_600, assertionLiveness: 7_200 };
  const config = {
    proposer: PROPOSER,
    sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"),
    subjectId: encodeBytes32String("HKO"),
    condition: { metricId, comparison: spec.comparison ?? 4, lower: spec.lower, upper: 0 },
    times,
  };
  const metric = { code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit), minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash };
  const context = { config, metricId, metric };
  const title = spec.title ?? "free text that is never shown as the question";
  const rulesDocument = buildHkoNumericRules({ title, targetDate: date }, context);
  const yes = spec.yes ?? 0n;
  const no = spec.no ?? 0n;
  return {
    id: spec.id,
    config: { ...config, condition: toBig(config.condition), times: toBig(times) },
    state: { yesTotal: yes, noTotal: no, paidOut: 0n, yesAccounts: yes > 0n ? 1n : 0n, noAccounts: no > 0n ? 1n : 0n, terminal: 0n, refundReason: 0n },
    metric: { id: metricId, code: preset.code, unit: preset.unit, minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash },
    rulesDocument,
    rulesHash: keccak256(toUtf8Bytes(rulesDocument)),
    title,
    position: { side: 0n, stake: 0n, claimed: false },
    claimable: 0n,
    assertion: { assertionId: ZeroHash, reading: { kind: 0n, value: 0n }, rawSha256: ZeroHash, proposedAt: 0n, disputed: false, returned: false, rejected: false },
    effectiveTerminal: spec.effective ?? 0n,
    effectiveRefundReason: spec.reason ?? 0n,
    mockResolutionReady: false,
  } as unknown as MarketView;
}

const hkt = (iso: string) => Math.floor(Date.parse(`${iso}+08:00`) / 1_000);
const PLAN = { proposalWindow: 7 * 86_400, assertionLiveness: 7_200, refundBuffer: 86_400 };
const humidity = HKO_DAILY_EXTRACT_FIELDS.find((f) => f.key === "mean-humidity")!;
const weeklyRain = customMetricRulesDocument({
  code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999_990, valueStep: 10, allowsTrace: true,
  interpretation: "Total rainfall at HKO headquarters over the market observation window, the sum of the daily totals.",
});
const pressure = customMetricRulesDocument({
  code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50_000, maxValue: 50_000, valueStep: 100, allowsTrace: false,
  interpretation: "Change in mean sea-level pressure at HKO headquarters over the observation window, in hPa.",
});
const SOURCE = { sourceName: "Hourly pressure log", sourceUrl: "https://example.org/pressure/hourly.csv", procedure: "Subtract the first hourly pressure in the window from the last one." };

function customView(id: number, metric: CustomMetric, condition: { comparison: number; lower: number; upper?: number }, times: MarketTimes, source: typeof SOURCE | { targetDate: string }): MarketView {
  const metricId = 10 + id;
  const field = "targetDate" in source;
  const config = {
    proposer: PROPOSER,
    sourceId: encodeBytes32String(field ? "HKO_DAILY_EXTRACT" : identifierFromText(source.sourceName, "CUSTOM_SOURCE")),
    subjectId: encodeBytes32String(field ? "HKO" : metric.definition.code),
    condition: { metricId, comparison: condition.comparison, lower: condition.lower, upper: condition.upper ?? 0 },
    times,
  };
  const chainMetric = { ...metric.definition, code: encodeBytes32String(metric.definition.code), unit: encodeBytes32String(metric.definition.unit), rulesHash: metric.rulesHash };
  const context = { config, metricId, metric: chainMetric };
  const title = "free text that is never shown as the question";
  const rulesDocument = field
    ? buildHkoFieldNumericRules({ title, targetDate: source.targetDate }, context)
    : buildCustomNumericRules({ title, ...source, metricRulesDocument: metric.rulesDocument }, context);
  const base = view({ id, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" });
  return {
    ...base,
    config: { ...config, condition: toBig(config.condition), times: toBig({ ...times }) },
    metric: { id: metricId, ...metric.definition, rulesHash: metric.rulesHash },
    rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)), title,
  } as unknown as MarketView;
}

function sportsView(id: number, sport: "BASKETBALL" | "FOOTBALL", lower = 0): MarketView {
  const preset = NUMERIC_METRIC_PRESETS.find((p) => p.code === (sport === "BASKETBALL" ? "SCORE_MARGIN" : "GOAL_MARGIN"))!;
  const match = sport === "BASKETBALL" ? { matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" } : { matchId: "ARS_CHE_DEMO01", teamA: "ARS", teamB: "CHE" };
  const metricId = 20 + id;
  const times = windowMarketTimes({ openAt: hkt("2026-11-06T08:00:00"), observationStart: hkt("2026-11-07T19:30:00"), observationEnd: hkt("2026-11-07T22:00:00"), plan: PLAN });
  const config = {
    proposer: PROPOSER, sourceId: encodeBytes32String(`DEMO_${sport}`), subjectId: encodeBytes32String(match.matchId),
    condition: { metricId, comparison: 3, lower, upper: 0 }, times,
  };
  const chainMetric = { code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit), minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash };
  const title = "free text that is never shown as the question";
  const rulesDocument = buildSportsNumericRules({ title, sport, ...match }, { config, metricId, metric: chainMetric });
  const base = view({ id, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" });
  return {
    ...base,
    config: { ...config, condition: toBig(config.condition), times: toBig({ ...times }) },
    metric: { id: metricId, code: preset.code, unit: preset.unit, minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep, allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash },
    rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)), title,
  } as unknown as MarketView;
}

const dashboard = (markets: MarketView[]) => ({ now: 0, blockNumber: 1, metrics: [], markets, bondBalance: 0n, bondAmount: 0n }) as unknown as Dashboard;

describe("market view model", () => {
  it("builds the question from the metric, the condition and the checked rules in both languages", () => {
    const rain = toMarketData(local, view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" }));
    const heat = toMarketData(local, view({ id: 2, code: "DAILY_MAX_TEMPERATURE", comparison: 3, lower: 2850, targetDate: "20261104" }));
    expect(rain.subject).toEqual({ kind: "HKO", targetDate: "20261103" });
    setActiveLocale("zh-CN");
    expect(questionOf(rain)).toBe("11月3日 天文台总部降雨量 ≥ 1.0 毫米？");
    expect(questionOf(heat)).toBe("11月4日 天文台总部最高气温 > 28.5 °C？");
    expect(shortLabelOf(heat)).toBe("11月4日 最高温 > 28.5");
    setActiveLocale("en");
    expect(questionOf(rain)).toBe("Will HKO headquarters record ≥ 1.0 mm of rain on 3 Nov?");
    expect(questionOf(heat)).toBe("Will the HKO headquarters maximum temperature be > 28.5 °C on 4 Nov?");
    expect(questionOf(rain)).not.toContain("free text");
  });

  it("refuses to guess for rules that do not match the chain", () => {
    const tampered = view({ id: 4, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" });
    const changed = toMarketData(local, { ...tampered, rulesDocument: tampered.rulesDocument.replace("20261103", "20261104") });
    expect(changed.subject).toEqual({ kind: "UNRECOGNIZED" });
  });

  it("shows the official Observatory markets newest first and sorts metrics into weather types", () => {
    const markets = [
      view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" }),
      view({ id: 3, code: "DAILY_MAX_TEMPERATURE", lower: 2700, targetDate: "20261104" }),
    ];
    expect(marketsFrom(sepolia, dashboard(markets)).map((m) => m.id)).toEqual([3, 1]);
    expect(marketsFrom(local, dashboard(markets)).map((m) => m.id)).toEqual([3, 1]);
    expect(["TOTAL_RAINFALL", "DAILY_MAX_TEMPERATURE", "WEEKLY_RAINFALL", "DAILY_MIN_TEMPERATURE", "DAILY_MEAN_HUMIDITY"].map(metricKindOf))
      .toEqual(["rain", "heat", "rain", "heat", "humidity"]);
    expect(["HOURLY_RAINFALL", "AFTERNOON_TEMPERATURE", "MSL_PRESSURE"].map(metricKindOf)).toEqual(["rain", "heat", "custom"]);
    const added = ["DAILY_MEAN_PRESSURE", "DAILY_MEAN_DEW_POINT", "DAILY_MEAN_CLOUD"];
    expect(added.map(metricKindOf)).toEqual(["custom", "humidity", "custom"]);
    expect(added.map(metricShortOf)).toEqual(["Pressure", "Dew point", "Cloud"]);
    setActiveLocale("zh-CN");
    expect(added.map(metricNameOf)).toEqual(["日平均气压", "日平均露点", "日平均云量"]);
    setActiveLocale("en");
  });

  it("reads custom markets from their checked rules: source, window, inclusive range and whole units, in both languages", () => {
    const band = toMarketData(local, customView(5, humidity.metric, { comparison: 5, lower: 7_000, upper: 8_500 }, hkDayMarketTimes({ openAt: hkt("2026-11-01T09:00:00"), targetDate: "20261105", plan: PLAN }), { targetDate: "20261105" }));
    const week = toMarketData(local, customView(6, weeklyRain, { comparison: 4, lower: 2_000 }, windowMarketTimes({ openAt: hkt("2026-10-31T09:00:00"), observationStart: hkt("2026-11-02T00:00:00"), observationEnd: hkt("2026-11-09T00:00:00"), plan: PLAN }), SOURCE));
    const fall = toMarketData(local, customView(7, pressure, { comparison: 1, lower: -500 }, windowMarketTimes({ openAt: hkt("2026-11-06T08:00:00"), observationStart: hkt("2026-11-07T08:30:00"), observationEnd: hkt("2026-11-07T11:30:00"), plan: PLAN }), SOURCE));
    expect(band.subject).toMatchObject({ kind: "CUSTOM", sourceName: "Hong Kong Observatory Daily Extract", targetDate: "20261105" });
    expect(week.subject).toEqual({ kind: "CUSTOM", ...SOURCE, targetDate: null });
    expect([band, week, fall].map(marketTagOf)).toEqual(["custom", "custom", "custom"]);
    expect([band.official, sourceOf(week), band.targetDate]).toEqual([false, SOURCE.sourceName, "20261105"]);
    expect([formatReading(-500, fall.metric), formatReading(2_340, week.metric), formatReading(8_500, band.metric)]).toEqual(["-5", "23.4", "85"]);
    setActiveLocale("zh-CN");
    expect(questionOf(band)).toBe("11月5日 日平均相对湿度介于 70% 与 85% 之间（含两端）？");
    expect(sourceOf(band)).toBe("香港天文台每日摘要");
    expect(questionOf(week)).toBe("11月2日至11月8日 WEEKLY RAINFALL ≥ 20.0 毫米？");
    expect(windowOf(fall)).toBe("11月7日 08:30–11:30");
    setActiveLocale("en");
    expect(questionOf(band)).toBe("Daily mean relative humidity, 5 Nov: will it be between 70% and 85% (inclusive)?");
    expect(questionOf(week)).toBe("WEEKLY RAINFALL, 2 Nov to 8 Nov: will it be ≥ 20.0 mm?");
    expect(questionOf(fall)).toBe("PRESSURE CHANGE, 7 Nov 08:30–11:30: will it be < -5 hPa?");
    expect(conditionWithUnitOf(band)).toBe("between 70% and 85% (inclusive)");
    expect(shortLabelOf(band)).toBe("5 Nov Humidity between 70 and 85 (inclusive)");
    expect([shortLabelOf(fall), shortLabelOf(week)]).toEqual(["7 Nov 08:30–11:30 PRESSURE CHANGE < -5", "2 Nov to 8 Nov WEEKLY RAINFALL ≥ 20.0"]);
  });

  it("shows custom markets on a public network after the official ones and labels each kind", () => {
    const official = view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" });
    const band = customView(3, humidity.metric, { comparison: 5, lower: 7_000, upper: 8_500 }, hkDayMarketTimes({ openAt: hkt("2026-11-01T09:00:00"), targetDate: "20261105", plan: PLAN }), { targetDate: "20261105" });
    const week = customView(4, weeklyRain, { comparison: 4, lower: 2_000 }, windowMarketTimes({ openAt: hkt("2026-10-31T09:00:00"), observationStart: hkt("2026-11-02T00:00:00"), observationEnd: hkt("2026-11-09T00:00:00"), plan: PLAN }), SOURCE);
    const markets = [official, band, week];
    expect(marketsFrom(sepolia, dashboard(markets)).map((m) => m.id)).toEqual([1, 4, 3]);
    expect(marketsFrom(local, dashboard(markets)).map((m) => [m.id, marketTagOf(m)])).toEqual([[1, "official"], [4, "custom"], [3, "custom"]]);
  });

  it("labels sports demos as synthetic, in both languages", () => {
    const game = toMarketData(local, sportsView(8, "BASKETBALL"));
    const derby = toMarketData(local, sportsView(9, "FOOTBALL", -100));
    expect(game.subject).toEqual({ kind: "SYNTHETIC", sport: "BASKETBALL", matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" });
    expect([marketTagOf(game), game.official, isDemo(game), metricKindOf(game.metric.code)]).toEqual(["demo", false, true, "sport"]);
    setActiveLocale("zh-CN");
    expect(questionOf(game)).toBe("LAL 对 BOS：分差（LAL − BOS）> 0 分？");
    expect(questionOf(derby)).toBe("ARS 对 CHE：净胜球（ARS − CHE）> -1 球？");
    expect([sourceOf(game), metricNameOf("SCORE_MARGIN"), shortLabelOf(game)]).toEqual(["合成演示数据", "篮球分差", "11月7日 19:30–22:00 分差 > 0"]);
    setActiveLocale("en");
    expect(questionOf(game)).toBe("LAL vs BOS: will the margin (LAL − BOS) be > 0 points?");
    expect(questionOf(derby)).toBe("ARS vs CHE: will the goal margin (ARS − CHE) be > -1 goals?");
    expect([sourceOf(game), windowOf(game)]).toEqual(["Synthetic demo data", "7 Nov 19:30–22:00"]);
  });

  it("keeps sports demos off a public network and after every weather market on the local chain", () => {
    const official = view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103" });
    const game = sportsView(2, "BASKETBALL");
    const band = customView(3, humidity.metric, { comparison: 5, lower: 7_000, upper: 8_500 }, hkDayMarketTimes({ openAt: hkt("2026-11-01T09:00:00"), targetDate: "20261105", plan: PLAN }), { targetDate: "20261105" });
    const derby = sportsView(4, "FOOTBALL");
    const markets = [official, game, band, derby];
    expect(marketsFrom(sepolia, dashboard(markets)).map((m) => m.id)).toEqual([1, 3]);
    expect(marketsFrom(local, dashboard(markets)).map((m) => [m.id, marketTagOf(m)])).toEqual([[1, "official"], [3, "custom"], [4, "demo"], [2, "demo"]]);
  });

  it("names phases from the chain's effective state and times, never ahead of it", () => {
    const m = toMarketData(local, view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103", yes: 10n }));
    expect(phaseOf(m, m.times.openAt - 1n)).toBe("SCHEDULED");
    expect(phaseOf(m, m.times.openAt)).toBe("OPEN");
    expect(phaseOf(m, m.times.closeAt)).toBe("WAITING_OBSERVATION");
    expect(phaseOf(m, m.times.earliestAssertionAt)).toBe("AWAITING_PROPOSAL");
    expect(phaseOf(m, m.times.proposalCutoff)).toBe("NO_PROPOSAL");
    const oneSided = toMarketData(local, view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103", yes: 10n, effective: 3n, reason: 2n }));
    expect([phaseOf(oneSided, oneSided.times.closeAt), oneSided.refundReason]).toEqual(["REFUND_ELIGIBLE", "SINGLE_SIDED"]);
  });

  it("settles by time on the local Mock and only after the client's check on Sepolia", () => {
    const proposed = (dep: MetricDeployment, ready: boolean) => {
      const v = view({ id: 1, code: "TOTAL_RAINFALL", lower: 100, targetDate: "20261103", yes: 10n, no: 10n });
      return toMarketData(dep, { ...v, assertion: { ...v.assertion, assertionId: `0x${"11".repeat(32)}` }, oracleAssertion: { settled: false, expirationTime: 2_000_000_000n, disputer: "0x0000000000000000000000000000000000000000", bond: 1n, asserter: PROPOSER }, settlementReady: ready } as unknown as MarketView);
    };
    expect(phaseOf(proposed(local, false), 1_999_999_999n)).toBe("PROPOSED");
    expect(phaseOf(proposed(local, false), 2_000_000_000n)).toBe("SETTLEABLE");
    expect(phaseOf(proposed(sepolia, false), 2_000_000_100n)).toBe("PROPOSED");
    expect(phaseOf(proposed(sepolia, true), 2_000_000_100n)).toBe("SETTLEABLE");
  });
});
