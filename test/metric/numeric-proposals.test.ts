import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeBytes32String, getBytes, hexlify, keccak256, sha256, toUtf8Bytes } from "ethers";
import { buildCustomNumericRules, customMetricRulesDocument } from "../../src/metric/custom-profile.js";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules, buildSportsNumericRules } from "../../src/metric/numeric-profiles.js";
import { buildCustomNumericProposal, buildHkoNumericProposal, buildSportsNumericProposal } from "../../src/metric/numeric-proposals.js";
import {
  parseNumericMarketRules, type NumericMarketRules, type NumericRulesContext,
} from "../../src/metric/numeric-rules.js";
import type { SportsDemoInput } from "../../src/metric/sports-demo.js";
import { buildObservationBundle } from "../../src/weather/observation-evidence.js";
import { parseDailyExtractObservation } from "../../src/weather/observations.js";
import type { RawEvidence } from "../../src/weather/parse.js";
import { hkDayWindow } from "../../src/weather/profile.js";
type ProposalContext = Parameters<typeof buildHkoNumericProposal>[1];
type PresetKey = "rainfall" | "temperature" | "score-margin" | "goal-margin";
const hash = (text: string) => keccak256(toUtf8Bytes(text));

function chainContext(
  key: PresetKey, sourceId: string, subjectId: string, start = 1800000000, end = start + 60,
): NumericRulesContext {
  const preset = NUMERIC_METRIC_PRESETS.find((entry) => entry.key === key);
  if (!preset) throw new Error(`missing numeric preset ${key}`);
  return {
    metricId: 1,
    metric: {
      code: encodeBytes32String(preset.code), unit: encodeBytes32String(preset.unit),
      minValue: preset.minValue, maxValue: preset.maxValue, valueStep: preset.valueStep,
      allowsTrace: preset.allowsTrace, rulesHash: preset.rulesHash,
    },
    config: {
      proposer: "0x1111111111111111111111111111111111111111",
      sourceId: encodeBytes32String(sourceId), subjectId: encodeBytes32String(subjectId),
      condition: { metricId: 1, comparison: 3, lower: key === "temperature" ? 3200 : 0, upper: 0 },
      times: {
        openAt: start - 120, closeAt: start - 60, observationStart: start, observationEnd: end,
        earliestAssertionAt: end + 60, proposalCutoff: end + 40 * 86400,
        refundAt: end + 40 * 86400 + 60 + 3600, assertionLiveness: 60,
      },
    },
  };
}

function proposalContext(rulesDocument: string, expected: NumericRulesContext, chainTimestamp: number): ProposalContext {
  return { rulesDocument, expected: { ...expected, marketRulesHash: hash(rulesDocument) }, chainTimestamp };
}

/** A custom weather market: a weekly rainfall total read from a document the proposer imports. */
function customFixture() {
  const metric = customMetricRulesDocument({
    code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999_990, valueStep: 10, allowsTrace: false,
    interpretation: "Total rainfall at HKO headquarters over the market observation window, in mm.",
  });
  const start = 1800000000;
  const end = start + 7 * 86400;
  const expected: NumericRulesContext = {
    metricId: 1,
    metric: { ...metric.definition, code: encodeBytes32String(metric.definition.code), unit: encodeBytes32String(metric.definition.unit), rulesHash: metric.rulesHash },
    config: {
      proposer: "0x1111111111111111111111111111111111111111",
      sourceId: encodeBytes32String("WEEKLY_REPORT"), subjectId: encodeBytes32String("WEEKLY_RAINFALL"),
      condition: { metricId: 1, comparison: 4, lower: 2000, upper: 0 },
      times: {
        openAt: start - 120, closeAt: start - 60, observationStart: start, observationEnd: end,
        earliestAssertionAt: end + 60, proposalCutoff: end + 40 * 86400,
        refundAt: end + 40 * 86400 + 60 + 3600, assertionLiveness: 60,
      },
    },
  };
  const rulesDocument = buildCustomNumericRules({
    title: "Weekly rainfall at least 20 mm", sourceName: "Weekly report", sourceUrl: "https://example.org/weekly-rainfall",
    procedure: "Read the weekly total in mm from the report.", metricRulesDocument: metric.rulesDocument,
  }, expected);
  const rawBytes = toUtf8Bytes("Weekly rainfall: 23.4 mm");
  const capturedAt = end + 1;
  const context = proposalContext(rulesDocument, expected, end + 120);
  const build = (at = capturedAt, ctx = context) => buildCustomNumericProposal({ rawBytes, reading: "23.4", capturedAt: at }, ctx);
  return { rawBytes, capturedAt, context, build };
}

/** A sports demo market on one of the synthetic result files. */
function sportsFixture(file = "basketball-lal-bos.json") {
  const rawBytes = new Uint8Array(readFileSync(new URL(`../../fixtures/demo/sports/${file}`, import.meta.url)));
  const result = JSON.parse(new TextDecoder().decode(rawBytes)) as SportsDemoInput;
  const basketball = result.sport === "BASKETBALL";
  const expected = chainContext(
    basketball ? "score-margin" : "goal-margin",
    basketball ? "DEMO_BASKETBALL" : "DEMO_FOOTBALL",
    result.matchId,
  );
  const creation = { title: "Will team A win?", matchId: result.matchId, sport: result.sport, teamA: result.teamA, teamB: result.teamB };
  const rulesDocument = buildSportsNumericRules(creation, expected);
  const capturedAt = Number(expected.config.times.observationEnd) + 1;
  const context = proposalContext(rulesDocument, expected, Number(expected.config.times.earliestAssertionAt) + 60);
  return { rawBytes, result, creation, capturedAt, context };
}
const resultBytes = (result: unknown) => toUtf8Bytes(JSON.stringify(result));

const monthlyMetaUrl = new URL("../../fixtures/official/hko-daily-extract/dailyExtract_202609_20261002T095227Z.meta.json", import.meta.url);
const metadata = JSON.parse(readFileSync(monthlyMetaUrl, "utf8")) as {
  requestUrl: string; fetchedAt: string; httpStatus: number; contentType: string; lastModified: string;
};
const monthlyRaw: RawEvidence = {
  bytes: new Uint8Array(readFileSync(new URL("../../fixtures/official/hko-daily-extract/dailyExtract_202609_20261002T095227Z.raw", import.meta.url))),
  sourceURL: metadata.requestUrl, fetchedAt: metadata.fetchedAt, httpStatus: metadata.httpStatus,
  contentType: metadata.contentType, lastModified: metadata.lastModified,
};

function hkoFixture(key: "temperature" | "rainfall" = "temperature", targetDate = "20260914", lower?: number) {
  const window = hkDayWindow(targetDate);
  const expected = chainContext(key, "HKO_DAILY_EXTRACT", "HKO", Number(window.start), Number(window.end));
  if (lower !== undefined) expected.config.condition.lower = lower;
  const creation = { title: "A committed HKO daily observation", targetDate };
  const rulesDocument = buildHkoNumericRules(creation, expected);
  const metric = key === "temperature" ? "DAILY_MAX_TEMPERATURE_C" : "TOTAL_RAINFALL_MM";
  const bundle = buildObservationBundle(monthlyRaw, parseDailyExtractObservation(monthlyRaw, targetDate, metric));
  const capturedAt = Math.floor(Date.parse(metadata.fetchedAt) / 1000);
  const context = proposalContext(rulesDocument, expected, capturedAt + 60);
  return { bundle, capturedAt, context, creation };
}

function rewriteRules(context: ProposalContext, change: (rules: NumericMarketRules) => void): ProposalContext {
  const rules = parseNumericMarketRules(context.rulesDocument);
  change(rules);
  const rulesDocument = JSON.stringify(rules);
  return { ...context, rulesDocument, expected: { ...context.expected, marketRulesHash: hash(rulesDocument) } };
}


describe("creation profiles", () => {
  it("fixes the source and ordered match parameters without including future scores", () => {
    const f = sportsFixture();
    const rules = parseNumericMarketRules(f.context.rulesDocument);
    expect(rules.synthetic).toBe(true);
    expect(rules.subject.parameters).toEqual({
      matchId: "LAL_BOS_DEMO01", sport: "BASKETBALL", teamA: "LAL", teamB: "BOS", scoreScope: "INCLUDING_OVERTIME",
    });
    expect(rules.subject.parameters).not.toHaveProperty("scoreA");
    expect(rules.subject.parameters).not.toHaveProperty("scoreB");
    expect(rules).not.toHaveProperty("fixture");
    expect(rules).not.toHaveProperty("expectedFixtureSha256");
    expect(rules.config.condition.lower).toBe(0);
  });

  it("fixes HKO station, date and timezone and rejects result-bearing creation inputs", () => {
    const f = hkoFixture();
    const rules = parseNumericMarketRules(f.context.rulesDocument);
    expect(rules.synthetic).toBe(false);
    expect(rules.subject.parameters).toEqual({ station: "HKO", targetDate: "20260914", timezone: "Asia/Hong_Kong" });
    const hkoExpected: NumericRulesContext = {
      config: f.context.expected.config, metricId: f.context.expected.metricId, metric: f.context.expected.metric,
    };
    expect(() => buildHkoNumericRules({ ...f.creation, value100: 2870 } as unknown as Parameters<typeof buildHkoNumericRules>[0], hkoExpected)).toThrow();
    const sport = sportsFixture();
    const sportsExpected: NumericRulesContext = {
      config: sport.context.expected.config, metricId: sport.context.expected.metricId, metric: sport.context.expected.metric,
    };
    expect(() => buildSportsNumericRules({ ...sport.creation, scoreA: 108 } as unknown as Parameters<typeof buildSportsNumericRules>[0], sportsExpected)).toThrow();
  });
});

describe("HKO numeric proposal conversion", () => {
  it.each([
    ["temperature", 2870], ["rainfall", 3790],
  ] as const)("extracts %s from the retained official September snapshot", (key, value) => {
    const f = hkoFixture(key);
    const proposal = buildHkoNumericProposal(f.bundle, f.context);
    expect(proposal.reading).toEqual({ kind: 1, value });
    expect(proposal.evidence).toEqual({
      sourceUrl: metadata.requestUrl, rawSha256: sha256(monthlyRaw.bytes),
      capturedAt: f.capturedAt, excerpt: hexlify(toUtf8Bytes(f.bundle.observation.excerpt)),
    });
    expect(proposal).not.toHaveProperty("outcome");
    expect(proposal).not.toHaveProperty("yes");
    // Local snapshot consistency is tested here. No network authenticity is established.
  });

  it("keeps a full monthly raw hash even though only a short day excerpt is published", () => {
    const f = hkoFixture();
    const proposal = buildHkoNumericProposal(f.bundle, f.context);
    expect(monthlyRaw.bytes.length).toBeGreaterThan(2048);
    expect(getBytes(proposal.evidence.excerpt).length).toBeLessThanOrEqual(2048);
    expect(proposal.evidence.rawSha256).not.toBe(sha256(proposal.evidence.excerpt));
  });

  it.each([0, 10])("keeps TRACE as kind 2/value 0 for a determinate > %i condition", (lower) => {
    const f = hkoFixture("rainfall", "20260913", lower);
    expect(buildHkoNumericProposal(f.bundle, f.context).reading).toEqual({ kind: 2, value: 0 });
  });

  // With the 0.1 mm rainfall step every reportable threshold is <= 0 or >= 0.05 mm, so TRACE
  // always decides an HKO rainfall market. Thresholds the metric cannot report never get rules.
  it("refuses rules for a threshold the rainfall metric cannot report", () => {
    expect(() => hkoFixture("rainfall", "20260913", 2)).toThrow(/metric step/);
  });

  it.each([
    [0, 0, true], [10, 20, true], [0, 10, true],
    [-10, 0, false], [5, 10, false], [0, 5, false], [1, 4, false], [0, 4, false], [1, 5, false],
  ] as const)("keeps TRACE for the inclusive range [%i,%i] only if the metric can report it", (lower, upper, reportable) => {
    const f = hkoFixture("rainfall", "20260913");
    const expected: NumericRulesContext = {
      config: {
        ...f.context.expected.config,
        condition: { ...f.context.expected.config.condition, comparison: 5, lower, upper },
      },
      metricId: f.context.expected.metricId,
      metric: f.context.expected.metric,
    };
    if (!reportable) {
      expect(() => buildHkoNumericRules(f.creation, expected)).toThrow(/metric (range|step)/);
      return;
    }
    const rulesDocument = buildHkoNumericRules(f.creation, expected);
    const context = proposalContext(rulesDocument, expected, f.context.chainTimestamp);
    expect(buildHkoNumericProposal(f.bundle, context).reading).toEqual({ kind: 2, value: 0 });
  });

  it("rejects wrong-day and wrong-metric bundles even when each bundle is independently valid", () => {
    const target = hkoFixture();
    expect(() => buildHkoNumericProposal(hkoFixture("temperature", "20260913").bundle, target.context)).toThrow();
    expect(() => buildHkoNumericProposal(hkoFixture("rainfall").bundle, target.context)).toThrow();
  });

  it("re-parses raw bytes instead of trusting a displayed observation or self-reported hash", () => {
    const f = hkoFixture();
    expect(() => buildHkoNumericProposal({
      ...f.bundle, observation: { ...f.bundle.observation, value: 9990 },
    }, f.context)).toThrow();
    expect(() => buildHkoNumericProposal({
      ...f.bundle, observation: { ...f.bundle.observation, rawSha256: sha256(toUtf8Bytes("forged")) },
    }, f.context)).toThrow();
  });

  it("rejects a lookalike HKO URL and a synthetic label on the weather evidence", () => {
    const f = hkoFixture();
    expect(() => buildHkoNumericProposal({
      ...f.bundle, observation: { ...f.bundle.observation, sourceURL: "https://www.hko.gov.hk.attacker.test/data" },
    }, f.context)).toThrow();
    expect(() => buildHkoNumericProposal({
      ...f.bundle, observation: { ...f.bundle.observation, mode: "DEMO_FIXTURE" },
    }, f.context)).toThrow();
  });

  it("rejects evidence captured after the supplied chain timestamp", () => {
    const f = hkoFixture();
    expect(() => buildHkoNumericProposal(f.bundle, { ...f.context, chainTimestamp: f.capturedAt - 1 })).toThrow();
  });
});

describe("supported profile semantics", () => {
  it.each([
    ["synthetic", (rules: NumericMarketRules) => { rules.synthetic = true; }],
    ["source URI", (rules: NumericMarketRules) => { rules.source.uri = "https://other.example/weather"; }],
    ["result schema", (rules: NumericMarketRules) => { rules.source.resultSchema = "OTHER_SCHEMA"; }],
    ["date", (rules: NumericMarketRules) => { rules.subject.parameters.targetDate = "20260913"; }],
    ["procedure", (rules: NumericMarketRules) => { rules.source.procedure = "Use the minimum instead."; }],
    ["revision policy", (rules: NumericMarketRules) => { rules.policies.revision = "The operator can replace finalized results."; }],
  ] as const)("rejects an unsupported HKO %s even if the outer rules hash was committed", (_name, change) => {
    const f = hkoFixture();
    expect(() => buildHkoNumericProposal(f.bundle, rewriteRules(f.context, change))).toThrow();
  });

  it("rejects a different metric interpretation even when its document and both expected hashes agree", () => {
    const f = hkoFixture();
    const altered = rewriteRules(f.context, (rules) => {
      const inner = JSON.parse(rules.metric.rulesDocument) as Record<string, unknown>;
      inner.interpretation = "Use daily minimum temperature.";
      rules.metric.rulesDocument = JSON.stringify(inner);
      rules.metric.rulesHash = hash(rules.metric.rulesDocument);
    });
    altered.expected = { ...altered.expected, metric: { ...altered.expected.metric, rulesHash: parseNumericMarketRules(altered.rulesDocument).metric.rulesHash } };
    expect(() => buildHkoNumericProposal(f.bundle, altered)).toThrow();
  });

  it("rejects a different onchain source even when the rules and independent config agree", () => {
    const f = hkoFixture();
    const altered = rewriteRules(f.context, (rules) => { rules.config.sourceId = "OTHER_SOURCE"; });
    altered.expected = {
      ...altered.expected,
      config: { ...altered.expected.config, sourceId: encodeBytes32String("OTHER_SOURCE") },
    };
    expect(() => buildHkoNumericProposal(f.bundle, altered)).toThrow();
  });

  it("rejects a result when the supplied rules do not match the independently read market hash", () => {
    const f = customFixture();
    const changed = rewriteRules(f.context, (rules) => { rules.title = "A different document"; });
    changed.expected.marketRulesHash = f.context.expected.marketRulesHash;
    expect(() => f.build(f.capturedAt, changed)).toThrow();
  });
});

describe("sports numeric proposal conversion", () => {
  it.each([
    ["basketball-lal-bos.json", 700], ["football-ars-che.json", 100], ["football-ars-che-draw.json", 0],
  ] as const)("converts %s into one standard signed reading", (file, value) => {
    const f = sportsFixture(file);
    const proposal = buildSportsNumericProposal(f.rawBytes, f.capturedAt, f.context);
    expect(proposal.reading).toEqual({ kind: 1, value });
    expect(proposal.evidence).toEqual({
      sourceUrl: parseNumericMarketRules(f.context.rulesDocument).source.uri,
      rawSha256: sha256(f.rawBytes), capturedAt: f.capturedAt, excerpt: hexlify(f.rawBytes),
    });
  });

  it("accepts different post-event scores under the same rules, including a negative margin", () => {
    const f = sportsFixture();
    const reverseScore = resultBytes({ ...f.result, scoreA: 101, scoreB: 108 });
    expect(buildSportsNumericProposal(f.rawBytes, f.capturedAt, f.context).reading.value).toBe(700);
    expect(buildSportsNumericProposal(reverseScore, f.capturedAt, f.context).reading.value).toBe(-700);
    expect(hash(f.context.rulesDocument)).toBe(f.context.expected.marketRulesHash);
  });

  it.each([
    ["match ID", { matchId: "OTHER_MATCH" }],
    ["team A", { teamA: "OTHER" }],
    ["team B", { teamB: "OTHER" }],
    ["scope", { scoreScope: "REGULATION_90" }],
    ["sport", { sport: "FOOTBALL" }],
  ] as Array<[string, Partial<SportsDemoInput>]>)("rejects a conflicting %s", (_name, change) => {
    const f = sportsFixture();
    expect(() => buildSportsNumericProposal(resultBytes({ ...f.result, ...change }), f.capturedAt, f.context)).toThrow();
  });

  it("does not silently reverse a result when both teams and scores are swapped", () => {
    const f = sportsFixture();
    const swapped = { ...f.result, teamA: f.result.teamB, teamB: f.result.teamA, scoreA: f.result.scoreB, scoreB: f.result.scoreA };
    expect(() => buildSportsNumericProposal(resultBytes(swapped), f.capturedAt, f.context)).toThrow();
  });

  it("normalizes permitted surrounding identity whitespace while preserving the original evidence bytes", () => {
    const f = sportsFixture();
    const bytes = resultBytes({ ...f.result, matchId: ` ${f.result.matchId} `, teamA: ` ${f.result.teamA} `, teamB: ` ${f.result.teamB} ` });
    const proposal = buildSportsNumericProposal(bytes, f.capturedAt, f.context);
    expect(proposal.reading.value).toBe(700);
    expect(proposal.evidence.rawSha256).toBe(sha256(bytes));
    expect(proposal.evidence.excerpt).toBe(hexlify(bytes));
  });

  it("preserves BOM, CRLF and trailing whitespace rather than hashing normalized JSON", () => {
    const f = sportsFixture();
    const text = JSON.stringify(f.result, null, 2).replaceAll("\n", "\r\n") + "\r\n ";
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...toUtf8Bytes(text)]);
    const proposal = buildSportsNumericProposal(bytes, f.capturedAt, f.context);
    expect(proposal.reading.value).toBe(700);
    expect(proposal.evidence.rawSha256).toBe(sha256(bytes));
    expect(proposal.evidence.excerpt).toBe(hexlify(bytes));
    expect(proposal.evidence.rawSha256).not.toBe(sha256(resultBytes(f.result)));
  });

  it("rejects malformed, duplicate-key, unknown-field and unavailable-result inputs", () => {
    const f = sportsFixture();
    const text = JSON.stringify(f.result);
    const invalid = [
      new Uint8Array(), new Uint8Array([0xff]), toUtf8Bytes("{"), toUtf8Bytes("[]"),
      toUtf8Bytes(text.replace('"scoreA":108', '"scoreA":108,"scoreA":109')),
      resultBytes({ ...f.result, capturedAt: f.capturedAt }),
      resultBytes({ ...f.result, synthetic: false }),
      resultBytes({ ...f.result, status: "LIVE" }),
      resultBytes({ ...f.result, scoreA: "108" }),
      resultBytes({ ...f.result, scoreA: 108.5 }),
      resultBytes({ ...f.result, scoreA: -1 }),
    ];
    for (const bytes of invalid) {
      expect(() => buildSportsNumericProposal(bytes, f.capturedAt, f.context)).toThrow();
    }
  });

  it("enforces the 2048-byte sports evidence limit while preserving padding at the boundary", () => {
    const f = sportsFixture();
    const compact = JSON.stringify(f.result);
    const bytes = toUtf8Bytes(compact + " ".repeat(2048 - toUtf8Bytes(compact).length));
    const proposal = buildSportsNumericProposal(bytes, f.capturedAt, f.context);
    expect(getBytes(proposal.evidence.excerpt).length).toBe(2048);
    expect(proposal.evidence.rawSha256).toBe(sha256(bytes));
    expect(() => buildSportsNumericProposal(new Uint8Array([...bytes, 0x20]), f.capturedAt, f.context)).toThrow();
  });

  it("rejects a valid integer score margin outside the registered preset range", () => {
    const f = sportsFixture();
    expect(() => buildSportsNumericProposal(resultBytes({ ...f.result, scoreA: 501, scoreB: 0 }), f.capturedAt, f.context)).toThrow();
  });
});

describe("proposal and capture times", () => {
  it("accepts capture exactly at observation end and exactly at the chain timestamp", () => {
    const f = customFixture();
    for (const capturedAt of [Number(f.context.expected.config.times.observationEnd), f.context.chainTimestamp]) {
      expect(f.build(capturedAt).evidence.capturedAt).toBe(capturedAt);
    }
  });

  it("rejects invalid capture timestamps without substituting file or computer time", () => {
    const f = customFixture();
    const invalid: unknown[] = [
      0, Number(f.context.expected.config.times.observationEnd) - 1, f.context.chainTimestamp + 1,
      f.capturedAt + 0.5, Number.MAX_SAFE_INTEGER + 1, String(f.capturedAt),
    ];
    for (const value of invalid) expect(() => f.build(value as number)).toThrow();
  });

  it("accepts the first proposal second and the final second before cutoff", () => {
    const f = customFixture();
    for (const chainTimestamp of [
      Number(f.context.expected.config.times.earliestAssertionAt),
      Number(f.context.expected.config.times.proposalCutoff) - 1,
    ]) {
      expect(f.build(f.capturedAt, { ...f.context, chainTimestamp }).reading.value).toBe(2340);
    }
  });

  it("rejects timestamps outside the proposal window and malformed chain time", () => {
    const f = customFixture();
    const invalid: unknown[] = [
      Number(f.context.expected.config.times.earliestAssertionAt) - 1,
      Number(f.context.expected.config.times.proposalCutoff), 0, f.context.chainTimestamp + 0.5,
      Number.MAX_SAFE_INTEGER + 1, String(f.context.chainTimestamp),
    ];
    for (const chainTimestamp of invalid) {
      expect(() => f.build(f.capturedAt, { ...f.context, chainTimestamp: chainTimestamp as number })).toThrow();
    }
  });
});
