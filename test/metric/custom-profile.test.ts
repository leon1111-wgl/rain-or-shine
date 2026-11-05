import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeBytes32String, keccak256, sha256, toUtf8Bytes, toUtf8String, getBytes } from "ethers";
import {
  CUSTOM_POLICIES, CUSTOM_RESULT_SCHEMA, HKO_DAILY_EXTRACT_FIELDS, HKO_FIELD_SOURCE_NAME, MAX_CUSTOM_METRIC_DOCUMENT_BYTES,
  assertCustomNumericProfile, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument,
  findMetricRulesDocument, hkoFieldProcedure, identifierFromText, isCustomNumericRules, isSourceUrl, type CustomMetric,
  type CustomMetricInput,
} from "../../src/metric/custom-profile.js";
import { NUMERIC_METRIC_PRESETS } from "../../src/metric/numeric-profiles.js";
import { buildCustomNumericProposal, buildHkoFieldProposal } from "../../src/metric/numeric-proposals.js";
import {
  assertNumericMarketRulesMatchChain, conditionProblems, parseNumericMarketRules,
  type NumericMarketConfig, type NumericRulesContext,
} from "../../src/metric/numeric-rules.js";
import { hkDayMarketTimes, windowMarketTimes, type MarketTimes } from "../../src/metric/market-times.js";
import { dailyExtractMonthUrl, hkDayWindow } from "../../src/weather/profile.js";
import type { RawEvidence } from "../../src/weather/parse.js";

const PROPOSER = "0x1111111111111111111111111111111111111111";
const hash = (text: string) => keccak256(toUtf8Bytes(text));
const hkt = (iso: string) => Date.parse(`${iso}+08:00`) / 1000;
const PLAN = { proposalWindow: 86_400, assertionLiveness: 7_200, refundBuffer: 86_400 };

const MATRIX = [
  {
    name: "weekly rainfall total ≥ 20 mm",
    metric: {
      code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999990, valueStep: 10, allowsTrace: true,
      interpretation: "Total rainfall at HKO headquarters over the market observation window, the sum of the daily totals; Trace days count as zero unless every day is Trace.",
    },
    condition: { comparison: 4, lower: 2000, upper: 0 },
    times: windowMarketTimes({ openAt: hkt("2026-10-31T09:00:00"), observationStart: hkt("2026-11-02T00:00:00"), observationEnd: hkt("2026-11-09T00:00:00"), plan: PLAN }),
    source: { sourceName: "HKO Daily Extract, seven daily rows", sourceUrl: "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202611.xml", procedure: "Add column 8 (Total Rainfall (mm)) of the rows for 2 to 8 November 2026 in the monthly file captured after 9 November 00:00 HKT." },
    document: "day,rainfall_mm\n02,0.0\n03,Trace\n04,12.1\n05,3.4\n06,0.0\n07,7.9\n08,0.0\n",
    reading: "23.4", value: 2340,
  },
  {
    name: "afternoon temperature band 25.0–28.0 °C, inclusive",
    metric: {
      code: "AFTERNOON_TEMPERATURE", unit: "degC", minValue: -10000, maxValue: 10000, valueStep: 10, allowsTrace: false,
      interpretation: "Air temperature at HKO headquarters at 17:00 HKT, as the hourly reading of the committed source reports it.",
    },
    condition: { comparison: 5, lower: 2500, upper: 2800 },
    times: windowMarketTimes({ openAt: hkt("2026-11-05T09:00:00"), closeAt: hkt("2026-11-05T13:00:00"), observationStart: hkt("2026-11-05T14:00:00"), observationEnd: hkt("2026-11-05T17:00:00"), plan: PLAN }),
    source: { sourceName: "HKO current weather report", sourceUrl: "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en", procedure: "Read temperature.data[place=Hong Kong Observatory].value from the report whose updateTime is 17:00 HKT on the observation day." },
    document: JSON.stringify({ updateTime: "2026-11-05T17:02:00+08:00", temperature: { data: [{ place: "Hong Kong Observatory", value: 28, unit: "C" }] } }),
    reading: "28.0", value: 2800,
  },
  {
    name: "pressure change below −5 hPa",
    metric: {
      code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50000, maxValue: 50000, valueStep: 100, allowsTrace: false,
      interpretation: "Change in mean sea-level pressure at HKO headquarters over the observation window, in whole hPa.",
    },
    condition: { comparison: 1, lower: -500, upper: 0 },
    times: windowMarketTimes({ openAt: hkt("2026-11-06T08:00:00"), observationStart: hkt("2026-11-07T08:30:00"), observationEnd: hkt("2026-11-07T11:30:00"), plan: PLAN }),
    source: { sourceName: "Hourly pressure log", sourceUrl: "https://example.org/pressure-2026-11-07", procedure: "Read the hourly mean sea-level pressure at the start and the end of the window, and subtract the first from the last." },
    document: `<!doctype html><html><body>${"<p>hourly reading</p>".repeat(160)}<table id="log"><tr><td>08:30</td><td>1015</td></tr><tr><td>11:30</td><td>1008</td></tr></table></body></html>`,
    excerpt: '<table id="log"><tr><td>08:30</td><td>1015</td></tr><tr><td>11:30</td><td>1008</td></tr></table>',
    reading: "-7", value: -700,
  },
  {
    name: "peak gust at Waglan Island over ten minutes ≤ 60 km/h",
    metric: {
      code: "PEAK_GUST", unit: "kmh", minValue: 0, maxValue: 100000, valueStep: 1, allowsTrace: false,
      interpretation: "The highest gust at Waglan Island over the committed window, in km/h with two decimals.",
    },
    condition: { comparison: 2, lower: 6000, upper: 0 },
    times: windowMarketTimes({ openAt: hkt("2026-11-04T09:00:00"), observationStart: hkt("2026-11-05T16:00:00"), observationEnd: hkt("2026-11-05T16:10:00"), plan: PLAN }),
    source: { sourceName: "Regional wind report", sourceUrl: "https://example.org/wind/waglan/2026-11-05.txt", procedure: "Read the highest gust between 16:00 and 16:10 HKT on 5 November 2026 from the report." },
    document: "Waglan Island\nDate: 2026-11-05\nPeak gust 16:00-16:10: 48.27 km/h\nMean wind: 31.40 km/h\n",
    reading: "48.27", value: 4827,
  },
] as const;

function metricOf(input: CustomMetricInput) {
  return customMetricRulesDocument(input);
}
function contextFor(metric: CustomMetric, condition: { comparison: number; lower: number; upper: number }, times: MarketTimes, ids = { sourceId: "CUSTOM_SOURCE", subjectId: metric.definition.code }): NumericRulesContext {
  const config: NumericMarketConfig = {
    proposer: PROPOSER, sourceId: encodeBytes32String(ids.sourceId), subjectId: encodeBytes32String(ids.subjectId),
    condition: { metricId: 7, ...condition }, times,
  };
  const d = metric.definition;
  return {
    config, metricId: 7,
    metric: {
      code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), minValue: d.minValue, maxValue: d.maxValue,
      valueStep: d.valueStep, allowsTrace: d.allowsTrace, rulesHash: metric.rulesHash,
    },
  };
}
const expected = (context: NumericRulesContext, document: string) => ({ ...context, marketRulesHash: hash(document) });

describe("custom metric definitions", () => {
  it("writes the registry document in the presets' field order and binds its hash", () => {
    const metric = metricOf(MATRIX[3].metric);
    expect(Object.keys(JSON.parse(metric.rulesDocument) as object)).toEqual(Object.keys(JSON.parse(NUMERIC_METRIC_PRESETS[0]!.rulesDocument) as object));
    expect(metric.rulesHash).toBe(hash(metric.rulesDocument));
    expect(metric.definition).toEqual({ code: "PEAK_GUST", unit: "kmh", minValue: 0, maxValue: 100000, valueStep: 1, allowsTrace: false });
  });

  it.each([
    ["an empty range", { minValue: 100, maxValue: 0 }],
    ["a range without a step multiple", { minValue: 1, maxValue: 9, valueStep: 10 }],
    ["Trace outside millimetres", { allowsTrace: true }],
    ["an empty definition", { interpretation: " " }],
    ["a definition with surrounding spaces", { interpretation: " The value. " }],
    ["a code longer than 31 bytes", { code: "A".repeat(32) }],
    ["a definition too long to fit a market's rules", { interpretation: "x".repeat(MAX_CUSTOM_METRIC_DOCUMENT_BYTES) }],
  ])("refuses %s", (_name, change) => {
    expect(() => metricOf({ ...MATRIX[1].metric, ...change })).toThrow();
  });

  it("finds a metric's exact document among candidates by hash and fields, from text or bytes32 codes", () => {
    const metric = metricOf(MATRIX[0].metric);
    const other = metricOf(MATRIX[1].metric);
    const registered = { ...metric.definition, rulesHash: metric.rulesHash };
    expect(findMetricRulesDocument(registered, [other.rulesDocument, metric.rulesDocument])).toBe(metric.rulesDocument);
    const chain = { ...registered, code: encodeBytes32String(registered.code), unit: encodeBytes32String(registered.unit) };
    expect(findMetricRulesDocument(chain, [metric.rulesDocument])).toBe(metric.rulesDocument);
    expect(findMetricRulesDocument({ ...registered, valueStep: 20 }, [metric.rulesDocument])).toBeUndefined();
    expect(findMetricRulesDocument(registered, [`${metric.rulesDocument} `])).toBeUndefined();
  });

  it("derives on-chain identifiers from labels", () => {
    expect(identifierFromText("Regional wind report", "CUSTOM")).toBe("REGIONAL_WIND_REPORT");
    expect(identifierFromText("香港天文台", "CUSTOM_SOURCE")).toBe("CUSTOM_SOURCE");
    expect(identifierFromText("x".repeat(40), "CUSTOM")).toHaveLength(31);
  });

  it("offers every numeric column of the monthly Daily Extract as a fixed custom metric, never the official ones", () => {
    expect(HKO_DAILY_EXTRACT_FIELDS.map((field) => [field.metric.definition.code, field.column])).toEqual([
      ["DAILY_MIN_TEMPERATURE", 4], ["DAILY_MEAN_TEMPERATURE", 3], ["DAILY_MEAN_HUMIDITY", 6],
      ["DAILY_MEAN_PRESSURE", 1], ["DAILY_MEAN_DEW_POINT", 5], ["DAILY_MEAN_CLOUD", 7],
    ]);
    const official = NUMERIC_METRIC_PRESETS.filter((preset) => ["TOTAL_RAINFALL", "DAILY_MAX_TEMPERATURE"].includes(preset.code));
    for (const field of HKO_DAILY_EXTRACT_FIELDS) {
      expect(official.map((preset) => preset.rulesHash)).not.toContain(field.metric.rulesHash);
      expect(hkoFieldProcedure(field)).toContain(`column ${field.column} (${field.header})`);
    }
  });

  it("keeps the three original fields byte for byte, because Sepolia markets #5 and #6 commit them", () => {
    expect(HKO_DAILY_EXTRACT_FIELDS.slice(0, 3).map((field) => [field.key, field.metric.rulesHash.slice(0, 10), hash(hkoFieldProcedure(field)).slice(0, 10)])).toEqual([
      ["min-temperature", "0x9dbdb733", "0xb0bb9793"],
      ["mean-temperature", "0xe68cd0da", "0x9b3e6baf"],
      ["mean-humidity", "0xe9082092", "0xcc66a1bf"],
    ]);
  });
});

describe("custom market matrix", () => {
  for (const item of MATRIX) {
    it(`commits ${item.name} and proposes from the imported document`, () => {
      const metric = metricOf(item.metric);
      const context = contextFor(metric, item.condition, item.times, { sourceId: "CUSTOM_SOURCE", subjectId: item.metric.code });
      expect(conditionProblems(item.condition, metric.definition)).toEqual([]);
      const document = buildCustomNumericRules({ title: item.name, ...item.source, metricRulesDocument: metric.rulesDocument }, context);
      const rules = assertNumericMarketRulesMatchChain(document, expected(context, document));
      expect(isCustomNumericRules(rules)).toBe(true);
      expect(rules.source.resultSchema).toBe(CUSTOM_RESULT_SCHEMA);
      expect(rules.policies).toEqual(CUSTOM_POLICIES);
      expect(assertCustomNumericProfile(rules)).toEqual({ ...item.source, hko: undefined });
      expect(toUtf8Bytes(document).length).toBeLessThanOrEqual(4096);

      const raw = toUtf8Bytes(item.document);
      const capturedAt = item.times.observationEnd + 600;
      const proposal = buildCustomNumericProposal({
        rawBytes: raw, reading: item.reading, capturedAt,
        ...("excerpt" in item ? { excerpt: toUtf8Bytes(item.excerpt) } : {}),
      }, { rulesDocument: document, expected: expected(context, document), chainTimestamp: capturedAt + 60 });
      expect(proposal.reading).toEqual({ kind: 1, value: item.value });
      expect(proposal.evidence.rawSha256).toBe(sha256(raw));
      expect(proposal.evidence.sourceUrl).toBe(item.source.sourceUrl);
      expect(toUtf8String(getBytes(proposal.evidence.excerpt))).toBe("excerpt" in item ? item.excerpt : item.document);
    });
  }

  it("uses the contract's inclusive range: both bounds are inside", () => {
    const band = MATRIX[1];
    const metric = metricOf(band.metric).definition;
    expect(conditionProblems({ comparison: 5, lower: 2500, upper: 2500 }, metric)).toEqual([]);
    expect(conditionProblems({ comparison: 5, lower: 2800, upper: 2500 }, metric)).toEqual(["RANGE_ORDER"]);
    expect(conditionProblems({ comparison: 5, lower: 2505, upper: 2800 }, metric)).toEqual(["OFF_STEP"]);
    expect(conditionProblems({ comparison: 2, lower: 10010, upper: 0 }, metric)).toEqual(["OUTSIDE_RANGE"]);
    const rain = metricOf(MATRIX[0].metric).definition;
    expect(conditionProblems({ comparison: 3, lower: 3, upper: 0 }, { ...rain, valueStep: 1 })).toEqual(["TRACE_UNDECIDABLE"]);
  });

  it("accepts a Trace reading only where the metric allows Trace", () => {
    const item = MATRIX[0];
    const metric = metricOf(item.metric);
    const context = contextFor(metric, item.condition, item.times);
    const document = buildCustomNumericRules({ title: item.name, ...item.source, metricRulesDocument: metric.rulesDocument }, context);
    const at = item.times.observationEnd + 60;
    const proposal = buildCustomNumericProposal({ rawBytes: toUtf8Bytes(item.document), reading: "Trace", capturedAt: at },
      { rulesDocument: document, expected: expected(context, document), chainTimestamp: at });
    expect(proposal.reading).toEqual({ kind: 2, value: 0 });

    const gust = MATRIX[3];
    const gustMetric = metricOf(gust.metric);
    const gustContext = contextFor(gustMetric, gust.condition, gust.times);
    const gustDocument = buildCustomNumericRules({ title: gust.name, ...gust.source, metricRulesDocument: gustMetric.rulesDocument }, gustContext);
    const later = gust.times.observationEnd + 60;
    expect(() => buildCustomNumericProposal({ rawBytes: toUtf8Bytes(gust.document), reading: "TRACE", capturedAt: later },
      { rulesDocument: gustDocument, expected: expected(gustContext, gustDocument), chainTimestamp: later })).toThrow(/TRACE/);
  });
});

describe("custom market checks", () => {
  const item = MATRIX[3];
  const metric = metricOf(item.metric);
  const context = contextFor(metric, item.condition, item.times);
  const base = { title: item.name, ...item.source, metricRulesDocument: metric.rulesDocument };
  const document = buildCustomNumericRules(base, context);
  const at = item.times.observationEnd + 300;
  const proposalContext = { rulesDocument: document, expected: expected(context, document), chainTimestamp: at };

  it.each([
    ["a relative source URL", { sourceUrl: "/wind/waglan.txt" }],
    ["a source URL with spaces", { sourceUrl: "https://example.org/a b" }],
    ["an empty source name", { sourceName: "" }],
    ["a source name with a line break", { sourceName: "Wind\nreport" }],
    ["a source name longer than 128 bytes", { sourceName: "s".repeat(129) }],
    ["an empty procedure", { procedure: " " }],
    ["another metric's rules", { metricRulesDocument: metricOf(MATRIX[1].metric).rulesDocument }],
  ])("refuses %s", (_name, change) => {
    expect(() => buildCustomNumericRules({ ...base, ...change }, context)).toThrow();
  });

  it("tells a form which source links the rules accept", () => {
    expect(["https://example.org/a?b=1", "http://127.0.0.1:8080/x.csv", "ipfs://bafybeigdyrzt"].map(isSourceUrl)).toEqual([true, true, true]);
    expect(["/wind/waglan.txt", "https://example.org/a b", " https://example.org", "", `https://example.org/${"a".repeat(240)}`].map(isSourceUrl))
      .toEqual([false, false, false, false, false]);
  });

  it("refuses custom markets on the official metrics and tampered policies or parameters", () => {
    const rain = NUMERIC_METRIC_PRESETS.find((preset) => preset.code === "TOTAL_RAINFALL")!;
    const official = { definition: rain, rulesDocument: rain.rulesDocument, rulesHash: rain.rulesHash };
    expect(() => buildCustomNumericRules({ ...base, metricRulesDocument: rain.rulesDocument }, contextFor(official, { comparison: 4, lower: 100, upper: 0 }, item.times)))
      .toThrow(/official/);
    const rules = parseNumericMarketRules(document);
    expect(() => assertCustomNumericProfile({ ...rules, policies: { ...rules.policies, revision: "Anything goes." } })).toThrow(/policy/);
    expect(() => assertCustomNumericProfile({ ...rules, subject: { ...rules.subject, parameters: { note: "x" } } })).toThrow(/parameters/);
    expect(() => assertCustomNumericProfile({ ...rules, synthetic: true })).toThrow(/synthetic/);
  });

  it("refuses a market whose times break a contract rule", () => {
    expect(() => buildCustomNumericRules(base, contextFor(metric, item.condition, { ...item.times, refundAt: item.times.proposalCutoff + 7_200 }))).toThrow(/settle/);
    expect(() => buildCustomNumericRules(base, contextFor(metric, item.condition, { ...item.times, observationStart: item.times.closeAt - 1 }))).toThrow(/observation/);
  });

  it("hashes the exact bytes and requires an exact excerpt for a large document", () => {
    const large = toUtf8Bytes(`${"header line\n".repeat(300)}Peak gust 16:00-16:10: 48.27 km/h\n`);
    expect(() => buildCustomNumericProposal({ rawBytes: large, reading: "48.27", capturedAt: at }, proposalContext)).toThrow(/excerpt/);
    expect(() => buildCustomNumericProposal({ rawBytes: large, reading: "48.27", capturedAt: at, excerpt: toUtf8Bytes("Peak gust 16:00-16:10: 48.28 km/h") }, proposalContext)).toThrow(/copied exactly/);
    const ok = buildCustomNumericProposal({ rawBytes: large, reading: "48.27", capturedAt: at, excerpt: toUtf8Bytes("Peak gust 16:00-16:10: 48.27 km/h") }, proposalContext);
    expect(ok.evidence.rawSha256).toBe(sha256(large));
    expect(buildCustomNumericProposal({ rawBytes: toUtf8Bytes(`\uFEFF${item.document}`), reading: "48.27", capturedAt: at }, proposalContext).evidence.rawSha256)
      .not.toBe(sha256(toUtf8Bytes(item.document)));
  });

  it.each([
    ["a reading with three decimals", { reading: "48.271" }],
    ["a reading in words", { reading: "about 25 thousand" }],
    ["a reading off the metric's range", { reading: "-1" }],
    ["a capture before the observation ends", { capturedAt: item.times.observationEnd - 1 }],
    ["a capture after the chain time", { capturedAt: at + 1 }],
    ["an empty document", { rawBytes: new Uint8Array() }],
  ])("refuses %s", (_name, change) => {
    expect(() => buildCustomNumericProposal({ rawBytes: toUtf8Bytes(item.document), reading: item.reading, capturedAt: at, ...change }, proposalContext)).toThrow();
  });

  it("refuses a proposal outside the proposal window", () => {
    expect(() => buildCustomNumericProposal({ rawBytes: toUtf8Bytes(item.document), reading: item.reading, capturedAt: item.times.observationEnd },
      { ...proposalContext, chainTimestamp: item.times.proposalCutoff })).toThrow(/window/);
  });
});

describe("HKO Daily Extract fields", () => {
  const root = "../../fixtures/official/hko-daily-extract/dailyExtract_202609_20261002T095227Z";
  const meta = JSON.parse(readFileSync(new URL(`${root}.meta.json`, import.meta.url), "utf8")) as { requestUrl: string; fetchedAt: string; httpStatus: number; contentType: string; lastModified: string };
  const raw: RawEvidence = {
    bytes: new Uint8Array(readFileSync(new URL(`${root}.raw`, import.meta.url))), sourceURL: meta.requestUrl,
    fetchedAt: meta.fetchedAt, httpStatus: meta.httpStatus, contentType: meta.contentType, lastModified: meta.lastModified,
  };
  const capture = Math.floor(Date.parse(meta.fetchedAt) / 1000);

  function fieldMarket(key: string, condition: { comparison: number; lower: number; upper: number }) {
    const field = HKO_DAILY_EXTRACT_FIELDS.find((entry) => entry.key === key)!;
    const times = hkDayMarketTimes({ openAt: hkt("2026-09-10T09:00:00"), targetDate: "20260914", plan: { proposalWindow: 40 * 86_400, assertionLiveness: 7_200, refundBuffer: 86_400 } });
    const context = contextFor(field.metric, condition, times, { sourceId: "HKO_DAILY_EXTRACT", subjectId: "HKO" });
    const document = buildHkoFieldNumericRules({ title: `${key} on 14 September 2026`, targetDate: "20260914" }, context);
    return { field, times, context, document };
  }

  it.each([
    ["min-temperature", { comparison: 2, lower: 2700, upper: 0 }, 2610],
    ["mean-temperature", { comparison: 5, lower: 2700, upper: 2800 }, 2780],
    ["mean-humidity", { comparison: 5, lower: 7000, upper: 8500 }, 8400],
    ["mean-pressure", { comparison: 4, lower: 101000, upper: 0 }, 101410],
    ["mean-dew-point", { comparison: 4, lower: 2400, upper: 0 }, 2480],
    ["mean-cloud", { comparison: 3, lower: 7000, upper: 0 }, 8800],
  ])("reads %s from the target day's row and commits the column", (key, condition, value) => {
    const market = fieldMarket(key, condition);
    const rules = assertNumericMarketRulesMatchChain(market.document, expected(market.context, market.document));
    const profile = assertCustomNumericProfile(rules);
    expect(profile).toMatchObject({ sourceName: HKO_FIELD_SOURCE_NAME, sourceUrl: dailyExtractMonthUrl("20260914"), hko: { targetDate: "20260914", field: market.field } });
    const proposal = buildHkoFieldProposal(raw, { rulesDocument: market.document, expected: expected(market.context, market.document), chainTimestamp: capture + 60 });
    expect(proposal.reading).toEqual({ kind: 1, value });
    expect(proposal.evidence).toMatchObject({ rawSha256: sha256(raw.bytes), capturedAt: capture, sourceUrl: meta.requestUrl });
    expect(toUtf8String(getBytes(proposal.evidence.excerpt))).toBe(JSON.stringify(["14", "1014.1", "28.7", "27.8", "26.1", "24.8", "84", "88", " 37.9"]));
  });

  it("refuses an HKO field market whose day, column, URL or window was changed", () => {
    const market = fieldMarket("min-temperature", { comparison: 2, lower: 2700, upper: 0 });
    const rules = parseNumericMarketRules(market.document);
    const parameters = rules.subject.parameters;
    for (const changed of [
      { ...rules, subject: { ...rules.subject, parameters: { ...parameters, column: "3" } } },
      { ...rules, subject: { ...rules.subject, parameters: { ...parameters, targetDate: "20260915" } } },
      { ...rules, source: { ...rules.source, uri: dailyExtractMonthUrl("20261014") } },
      { ...rules, config: { ...rules.config, times: { ...rules.config.times, observationEnd: rules.config.times.observationEnd - 3600 } } },
    ]) expect(() => assertCustomNumericProfile(changed)).toThrow();
    const window = hkDayWindow("20260914");
    expect(rules.config.times.observationStart).toBe(Number(window.start));
    expect(() => buildCustomNumericProposal({ rawBytes: raw.bytes, reading: "26.1", capturedAt: capture },
      { rulesDocument: market.document, expected: expected(market.context, market.document), chainTimestamp: capture })).toThrow(/HKO Daily Extract/);
    expect(() => buildHkoFieldNumericRules({ title: "x", targetDate: "20260914" }, contextFor(metricOf(MATRIX[1].metric), MATRIX[1].condition, market.times))).toThrow(/field/);
  });

  it("refuses another month's file and an unpublished day", () => {
    const market = fieldMarket("mean-humidity", { comparison: 5, lower: 7000, upper: 8500 });
    const context = { rulesDocument: market.document, expected: expected(market.context, market.document), chainTimestamp: capture + 60 };
    expect(() => buildHkoFieldProposal({ ...raw, sourceURL: dailyExtractMonthUrl("20261001") }, context)).toThrow();
    expect(() => buildHkoFieldProposal({ ...raw, fetchedAt: null }, context)).toThrow();
  });
});
