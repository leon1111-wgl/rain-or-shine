import { describe, expect, it } from "vitest";
import { AbiCoder, encodeBytes32String, keccak256, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers";
import {
  assertNumericMarketRulesMatchChain, buildNumericMarketRules, parseNumericMarketRules,
  type NumericMarketRulesInput, type NumericMetricRules, type NumericRulesContext,
  type NumericRulesChainExpectation,
} from "../../src/metric/numeric-rules.js";

const START = Date.parse("2026-10-20T00:00:00+08:00") / 1000;
const hash = (document: string) => keccak256(toUtf8Bytes(document));

function fixture(overrides: Partial<NumericMetricRules> = {}) {
  const metricDocument: NumericMetricRules = {
    schema: "RAINPOOL_NUMERIC_METRIC_V1", code: "DAILY_MAX_TEMPERATURE", unit: "degC",
    scale: 100, minValue: -10000, maxValue: 10000, valueStep: 10, allowsTrace: false,
    interpretation: "Read the selected day's maximum temperature in degrees Celsius; multiply by 100 without rounding.",
    ...overrides,
  };
  const metricRulesDocument = JSON.stringify(metricDocument);
  const context: NumericRulesContext = {
    metricId: 1,
    metric: {
      code: encodeBytes32String(metricDocument.code), unit: encodeBytes32String(metricDocument.unit),
      minValue: metricDocument.minValue, maxValue: metricDocument.maxValue,
      valueStep: metricDocument.valueStep, allowsTrace: metricDocument.allowsTrace,
      rulesHash: hash(metricRulesDocument),
    },
    config: {
      proposer: "0x1111111111111111111111111111111111111111",
      sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"), subjectId: encodeBytes32String("HKO"),
      condition: { metricId: 1, comparison: 3, lower: 3200, upper: 0 },
      times: {
        openAt: START - 120, closeAt: START - 60,
        observationStart: START, observationEnd: START + 86400,
        earliestAssertionAt: START + 86460, proposalCutoff: START + 90000,
        refundAt: START + 97200, assertionLiveness: 60,
      },
    },
  };
  const input: NumericMarketRulesInput = {
    title: "Will the daily maximum temperature exceed 32 degrees Celsius?",
    synthetic: false,
    source: {
      uri: "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202610.xml",
      resultSchema: "RAINPOOL_WEATHER_EVIDENCE_V3",
      procedure: "Use an authentic HKO monthly response captured after the observation day. Select the headquarters daily maximum temperature column.",
    },
    subject: {
      description: "Hong Kong Observatory headquarters during one Hong Kong calendar day.",
      parameters: { station: "HKO", targetDate: "20261020" },
    },
    policies: {
      finality: "Use a complete, unflagged daily value after the observation window ends.",
      missingData: "Do not propose missing or ambiguous data; refund after the deadline.",
      revision: "Preserve the submitted snapshot. Later revisions do not change a finalized market.",
    },
    metricRulesDocument,
  };
  return { input, context };
}

const expected = (context: NumericRulesContext, document: string): NumericRulesChainExpectation =>
  ({ ...context, marketRulesHash: hash(document) });

function changeAt<T>(input: T, path: readonly string[], value: unknown): T {
  const copy = structuredClone(input);
  let current = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) current = current[key] as Record<string, unknown>;
  Object.defineProperty(current, path.at(-1)!, { value, enumerable: true, configurable: true, writable: true });
  return copy;
}

const changeDocument = (document: string, path: readonly string[], value: unknown): string =>
  JSON.stringify(changeAt(JSON.parse(document) as Record<string, unknown>, path, value));

function checkBuilt(input: NumericMarketRulesInput, context: NumericRulesContext) {
  const document = buildNumericMarketRules(input, context);
  const parsed = parseNumericMarketRules(document);
  expect(assertNumericMarketRulesMatchChain(document, expected(context, document))).toEqual(parsed);
  return { document, parsed };
}

describe("numeric creation rules", () => {
  it("binds an HKO question without requiring a future result", () => {
    const { input, context } = fixture();
    const before = structuredClone({ input, context });
    const { parsed } = checkBuilt(input, context);
    expect(parsed.schema).toBe("RAINPOOL_NUMERIC_MARKET_V1");
    expect(parsed.protocol).toBe("NUMERIC_OBSERVATION_V1");
    expect(parsed.synthetic).toBe(false);
    expect(parsed.config.sourceId).toBe("HKO_DAILY_EXTRACT");
    expect(parsed.config.subjectId).toBe("HKO");
    expect(parsed.metric.code).toBe("DAILY_MAX_TEMPERATURE");
    expect(parsed.metric.rulesDocument).toBe(input.metricRulesDocument);
    expect(parsed.metric.rulesHash).toBe(context.metric.rulesHash);
    for (const key of ["fixture", "dataMode", "expectedFixtureSha256", "reading"]) {
      expect(parsed).not.toHaveProperty(key);
    }
    expect(parsed.metric).not.toHaveProperty("id");
    expect({ input, context }).toEqual(before);
  });

  it("fixes an ordered synthetic matchup before either score exists", () => {
    const { input, context } = fixture({
      code: "SCORE_MARGIN", unit: "points", minValue: -50000, maxValue: 50000, valueStep: 100,
      interpretation: "Final team A score minus final team B score, including overtime, multiplied by 100.",
    });
    input.title = "Will the Lakers beat the Celtics?";
    input.synthetic = true;
    input.source = {
      uri: "onchain:UmaMetricOracleAdapter.EvidencePublished.excerpt",
      resultSchema: "RAINPOOL_SPORTS_DEMO_V1",
      procedure: "The demonstration operator supplies one synthetic FINAL result after the observation window.",
    };
    input.subject = {
      description: "Lakers versus Celtics, in that order.",
      parameters: { matchId: "LAL_BOS_DEMO01", sport: "BASKETBALL", teamA: "LAL", teamB: "BOS", scoreScope: "INCLUDING_OVERTIME" },
    };
    context.config.sourceId = encodeBytes32String("DEMO_BASKETBALL");
    context.config.subjectId = encodeBytes32String("LAL_BOS_DEMO01");
    context.config.condition.lower = 0;
    const { parsed } = checkBuilt(input, context);
    expect(parsed.synthetic).toBe(true);
    expect(parsed.subject.parameters.teamA).toBe("LAL");
    expect(parsed.subject.parameters.teamB).toBe("BOS");
    expect(parsed.subject.parameters).not.toHaveProperty("scoreA");
    expect(parsed.subject.parameters).not.toHaveProperty("scoreB");
  });

  it("accepts a future numerical metric and source without a hardcoded preset", () => {
    const { input, context } = fixture({
      code: "MAX_WIND_GUST", unit: "mps", minValue: 0, maxValue: 100000, valueStep: 1,
      interpretation: "Maximum valid station gust during the committed interval, in metres per second.",
    });
    input.title = "Will the maximum gust exceed 20 metres per second?";
    input.source = { uri: "https://sensor.example/observations", resultSchema: "STATION_GUST_V1", procedure: "Select the largest valid reading for this station and interval." };
    input.subject = { description: "An additional station.", parameters: { station: "REMOTE01" } };
    context.config.sourceId = encodeBytes32String("STATION_GUST_SOURCE");
    context.config.subjectId = encodeBytes32String("REMOTE01");
    context.config.condition.lower = 2000;
    expect(checkBuilt(input, context).parsed.source.resultSchema).toBe("STATION_GUST_V1");
  });

  it("accepts actual named ethers ABI Result tuples with bigint integers", () => {
    const { input, context } = fixture();
    const configType = "tuple(address proposer,bytes32 sourceId,bytes32 subjectId,tuple(uint32 metricId,uint8 comparison,int32 lower,int32 upper) condition,tuple(uint64 openAt,uint64 closeAt,uint64 observationStart,uint64 observationEnd,uint64 earliestAssertionAt,uint64 proposalCutoff,uint64 refundAt,uint64 assertionLiveness) times)";
    const metricType = "tuple(bytes32 code,bytes32 unit,int32 minValue,int32 maxValue,uint32 valueStep,bool allowsTrace,bytes32 rulesHash)";
    const coder = AbiCoder.defaultAbiCoder();
    const decoded = coder.decode([configType, metricType], coder.encode([configType, metricType], [context.config, context.metric]));
    expect(decoded[0].condition.metricId).toBe(1n);
    expect(decoded[1].minValue).toBe(-10000n);
    const fromChain: NumericRulesContext = { config: decoded[0], metric: decoded[1], metricId: 1n };
    expect(buildNumericMarketRules(input, fromChain)).toBe(buildNumericMarketRules(input, context));
    checkBuilt(input, fromChain);
  });

  it("does not reject historical rules using the computer's current time", () => {
    const { input, context } = fixture();
    const offset = START - Date.parse("2020-01-01T00:00:00Z") / 1000;
    for (const key of Object.keys(context.config.times) as Array<keyof typeof context.config.times>) {
      if (key !== "assertionLiveness") context.config.times[key] = Number(context.config.times[key]) - offset;
    }
    checkBuilt(input, context);
  });

  it.each([
    ["between observation steps", { lower: 3201 }],
    ["above the metric range", { lower: 10010 }],
    ["below the metric range", { comparison: 1, lower: -10010 }],
    ["a range upper bound between steps", { comparison: 5, lower: 3200, upper: 3205 }],
    ["a range upper bound above the metric range", { comparison: 5, lower: 3200, upper: 10010 }],
  ])("rejects a threshold %s", (_name, change) => {
    const { input, context } = fixture();
    Object.assign(context.config.condition, change);
    expect(() => buildNumericMarketRules(input, context)).toThrow(/metric (range|step)/);
  });

  it("accepts thresholds on the metric step at both range edges", () => {
    for (const change of [{ lower: 10000 }, { comparison: 1, lower: -10000 }, { comparison: 5, lower: -10000, upper: 10000 }]) {
      const { input, context } = fixture();
      Object.assign(context.config.condition, change);
      checkBuilt(input, context);
    }
  });

  it.each([
    [3, 2, 0, false], [2, 4, 0, false], [5, 0, 4, false], [5, 1, 5, false],
    [3, 0, 0, true], [4, 5, 0, true], [5, 0, 5, true], [5, 5, 10, true], [5, -5, 0, true],
  ])("on a TRACE metric, comparison %i with [%i, %i] is decidable: %s", (comparison, lower, upper, decidable) => {
    const { input, context } = fixture({
      code: "FINE_RAINFALL", unit: "mm", minValue: -100, maxValue: 100000, valueStep: 1, allowsTrace: true,
    });
    Object.assign(context.config.condition, { comparison, lower, upper });
    if (decidable) checkBuilt(input, context);
    else expect(() => buildNumericMarketRules(input, context)).toThrow(/TRACE cannot decide/);
  });
});

describe("independent chain binding", () => {
  const changes: Array<[string, string[], unknown]> = [
    ["proposer", ["config", "proposer"], "0x2222222222222222222222222222222222222222"],
    ["sourceId", ["config", "sourceId"], encodeBytes32String("OTHER_SOURCE")],
    ["subjectId", ["config", "subjectId"], encodeBytes32String("OTHER_STATION")],
    ["comparison", ["config", "condition", "comparison"], 4],
    ["threshold", ["config", "condition", "lower"], 3210],
    ["openAt", ["config", "times", "openAt"], START - 119],
    ["closeAt", ["config", "times", "closeAt"], START - 59],
    ["observationStart", ["config", "times", "observationStart"], START + 1],
    ["observationEnd", ["config", "times", "observationEnd"], START + 86399],
    ["earliestAssertionAt", ["config", "times", "earliestAssertionAt"], START + 86461],
    ["proposalCutoff", ["config", "times", "proposalCutoff"], START + 90001],
    ["refundAt", ["config", "times", "refundAt"], START + 97201],
    ["assertionLiveness", ["config", "times", "assertionLiveness"], 61],
    ["metric code", ["metric", "code"], encodeBytes32String("OTHER_TEMPERATURE")],
    ["metric unit", ["metric", "unit"], encodeBytes32String("otherUnit")],
    ["metric minimum", ["metric", "minValue"], -10010],
    ["metric maximum", ["metric", "maxValue"], 10010],
    ["metric step", ["metric", "valueStep"], 20],
    ["metric rules hash", ["metric", "rulesHash"], hash("another registered rule")],
  ];
  it.each(changes)("rejects a different chain %s", (_name, path, value) => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    expect(() => assertNumericMarketRulesMatchChain(document, expected(changeAt(context, path, value), document))).toThrow();
  });

  it("binds the selected metric ID independently of matching metric fields", () => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    context.metricId = 2;
    expect(() => buildNumericMarketRules(input, context)).toThrow();
    context.config.condition.metricId = 2;
    expect(() => assertNumericMarketRulesMatchChain(document, expected(context, document))).toThrow();
  });

  it("binds the upper threshold of an inclusive range", () => {
    const { input, context } = fixture();
    context.config.condition.comparison = 5;
    context.config.condition.upper = 4000;
    const document = buildNumericMarketRules(input, context);
    context.config.condition.upper = 4010;
    expect(() => assertNumericMarketRulesMatchChain(document, expected(context, document))).toThrow(/upper/);
  });

  it("binds allowsTrace even when the changed chain definition is otherwise valid", () => {
    const { input, context } = fixture({ code: "TOTAL_RAINFALL", unit: "mm", minValue: 0, maxValue: 999990, allowsTrace: true });
    const document = buildNumericMarketRules(input, context);
    context.metric.allowsTrace = false;
    expect(() => assertNumericMarketRulesMatchChain(document, expected(context, document))).toThrow();
  });

  it("rejects replacing a metric document and its self-reported hash together", () => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    const replacement = changeDocument(input.metricRulesDocument, ["interpretation"], "Use the daily minimum instead.");
    const forged = changeDocument(changeDocument(document, ["metric", "rulesDocument"], replacement), ["metric", "rulesHash"], hash(replacement));
    expect(() => parseNumericMarketRules(forged)).not.toThrow();
    expect(() => assertNumericMarketRulesMatchChain(forged, expected(context, forged))).toThrow();
  });

  it("checks metric definition fields even if the inner document hash matches the registry", () => {
    const { input, context } = fixture();
    input.metricRulesDocument = changeDocument(input.metricRulesDocument, ["maxValue"], 20000);
    context.metric.rulesHash = hash(input.metricRulesDocument);
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });

  it("hashes the exact outer document, not its parsed or trimmed representation", () => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    const spaced = ` \n${document}\n `;
    expect(parseNumericMarketRules(spaced)).toEqual(parseNumericMarketRules(document));
    expect(hash(spaced)).not.toBe(hash(document));
    expect(() => assertNumericMarketRulesMatchChain(spaced, expected(context, document))).toThrow();
    expect(assertNumericMarketRulesMatchChain(spaced, expected(context, spaced))).toEqual(parseNumericMarketRules(document));
  });

  it("preserves whitespace in the exact nested metric document", () => {
    const { input, context } = fixture();
    input.metricRulesDocument = ` \n${input.metricRulesDocument}\n`;
    context.metric.rulesHash = hash(input.metricRulesDocument);
    const { parsed } = checkBuilt(input, context);
    expect(parsed.metric.rulesDocument).toBe(input.metricRulesDocument);
    expect(parsed.metric.rulesHash).not.toBe(hash(input.metricRulesDocument.trim()));
  });

  it("requires a nonzero expected market hash", () => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    expect(() => assertNumericMarketRulesMatchChain(document, { ...context, marketRulesHash: ZeroHash })).toThrow();
    expect(() => assertNumericMarketRulesMatchChain(document, { ...context, marketRulesHash: undefined } as unknown as NumericRulesChainExpectation)).toThrow();
  });
});

describe("strict rule schema", () => {
  it.each(["null", "[]", "\"text\"", "{", "{\"schema\":1}"])("rejects malformed or unsupported document %s", (document) => {
    expect(() => parseNumericMarketRules(document)).toThrow();
  });

  it.each(['"title":"first","title":', '"tit\\u006ce":"first","title":'])("rejects duplicate keys including escaped aliases: %s", (replacement) => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    const duplicate = document.replace('"title":', replacement);
    expect(duplicate).not.toBe(document);
    expect(() => parseNumericMarketRules(duplicate)).toThrow();
  });

  it("rejects duplicate keys in an embedded metric document", () => {
    const { input, context } = fixture();
    input.metricRulesDocument = input.metricRulesDocument.replace('"scale":100', '"scale":10,"scale":100');
    context.metric.rulesHash = hash(input.metricRulesDocument);
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });

  it.each([
    ["root", ["surprise"]], ["source", ["source", "surprise"]], ["subject", ["subject", "surprise"]],
    ["policies", ["policies", "surprise"]], ["config", ["config", "surprise"]],
    ["condition", ["config", "condition", "surprise"]], ["times", ["config", "times", "surprise"]],
    ["metric", ["metric", "surprise"]],
  ] as Array<[string, string[]]>)("rejects unknown fields in %s", (_name, path) => {
    const { input, context } = fixture();
    expect(() => parseNumericMarketRules(changeDocument(buildNumericMarketRules(input, context), path, "unexpected"))).toThrow();
  });

  it.each(["dataMode", "fixture", "expectedFixtureSha256", "reading", "scoreA", "rawSha256"])("rejects legacy or result-bearing root field %s", (name) => {
    const { input, context } = fixture();
    expect(() => parseNumericMarketRules(changeDocument(buildNumericMarketRules(input, context), [name], "not a creation rule"))).toThrow();
  });

  it.each([
    "__proto__", "constructor", "prototype", "value", "value100", "valueText", "reading", "result",
    "scoreA", "scoreB", "rawSha256", "expectedFixtureSha256", "fixture", "dataMode", "ScoreA",
  ])("rejects reserved subject parameter %s", (name) => {
    const { input, context } = fixture();
    expect(() => buildNumericMarketRules(changeAt(input, ["subject", "parameters", name], "not allowed"), context)).toThrow();
  });

  it.each([
    ["legacy schema", "schema", "RAINPOOL_METRIC_RULES_V1"],
    ["legacy demo branch", "demo", "Use a precommitted result"],
  ])("rejects %s in metric rules", (_name, key, value) => {
    const { input, context } = fixture();
    input.metricRulesDocument = changeDocument(input.metricRulesDocument, [key], value);
    context.metric.rulesHash = hash(input.metricRulesDocument);
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });

  it.each([
    ["synthetic", ["synthetic"], "false"], ["source URI", ["source", "uri"], ""],
    ["result schema", ["source", "resultSchema"], ""], ["procedure", ["source", "procedure"], ""],
    ["description", ["subject", "description"], ""], ["finality", ["policies", "finality"], ""],
    ["missing data", ["policies", "missingData"], ""], ["revision", ["policies", "revision"], ""],
  ] as Array<[string, string[], unknown]>)("requires valid %s", (_name, path, value) => {
    const { input, context } = fixture();
    expect(() => buildNumericMarketRules(changeAt(input, path, value), context)).toThrow();
  });

  it("rejects numeric strings, unknown builder input and a non-100 scale", () => {
    const { input, context } = fixture();
    const substitutions: Array<[string[], string]> = [
      [["metricId"], "1"],
      [["config", "condition", "lower"], "3200"],
      [["config", "times", "observationStart"], String(START)],
      [["metric", "valueStep"], "10"],
    ];
    for (const [path, value] of substitutions) {
      expect(() => buildNumericMarketRules(input, changeAt(context, path, value))).toThrow();
    }
    expect(() => buildNumericMarketRules(changeAt(input, ["unexpected"], true), context)).toThrow();
    const document = buildNumericMarketRules(input, context);
    expect(() => parseNumericMarketRules(changeDocument(document, ["metric", "scale"], 10))).toThrow();
    input.metricRulesDocument = changeDocument(input.metricRulesDocument, ["scale"], 10);
    context.metric.rulesHash = hash(input.metricRulesDocument);
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });
});

describe("byte and numeric boundaries", () => {
  it("measures title and URI limits in UTF-8 bytes", () => {
    const { input, context } = fixture();
    input.title = "中".repeat(80);
    const prefix = "https://example.test/";
    input.source.uri = prefix + "a".repeat(256 - toUtf8Bytes(prefix).length);
    checkBuilt(input, context);
    expect(() => buildNumericMarketRules({ ...input, title: `${input.title}中` }, context)).toThrow();
    expect(() => buildNumericMarketRules({ ...input, source: { ...input.source, uri: `${input.source.uri}a` } }, context)).toThrow();
  });

  it("accepts 4096 document bytes and rejects 4097, counting trailing whitespace", () => {
    const { input, context } = fixture();
    const document = buildNumericMarketRules(input, context);
    const remaining = 4096 - toUtf8Bytes(document).length;
    expect(remaining).toBeGreaterThan(0);
    const padded = document + " ".repeat(remaining);
    expect(toUtf8Bytes(padded).length).toBe(4096);
    expect(assertNumericMarketRulesMatchChain(padded, expected(context, padded))).toEqual(parseNumericMarketRules(document));
    expect(() => parseNumericMarketRules(`${padded} `)).toThrow();
  });

  it("enforces parameter key, value and count limits", () => {
    const { input, context } = fixture();
    input.subject.parameters = { ["A".repeat(32)]: "é".repeat(64) };
    checkBuilt(input, context);
    const invalidParameters: Array<Record<string, string>> = [
      { ["A".repeat(33)]: "value" }, { station: "é".repeat(65) }, { "two words": "value" }, { "站点": "value" },
    ];
    for (const parameters of invalidParameters) {
      expect(() => buildNumericMarketRules({ ...input, subject: { ...input.subject, parameters } }, context)).toThrow();
    }
    input.subject.parameters = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field${i}`, "value"]));
    checkBuilt(input, context);
    input.subject.parameters.field16 = "extra";
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });

  it("accepts a 31-byte identifier and rejects empty, padded or control-bearing IDs", () => {
    const { input, context } = fixture();
    context.config.subjectId = encodeBytes32String(`${"中".repeat(10)}A`);
    checkBuilt(input, context);
    for (const subject of ["", " ", " HKO", "HKO ", "HKO\n", "HKO\0X"]) {
      context.config.subjectId = encodeBytes32String(subject);
      expect(() => buildNumericMarketRules(input, context)).toThrow();
    }
  });

  it.each([
    ["zero proposer", ["config", "proposer"], ZeroAddress],
    ["fractional time", ["config", "times", "openAt"], START - 119.5],
    ["unsafe bigint time", ["config", "times", "refundAt"], 9007199254740992n],
    ["infinite time", ["config", "times", "refundAt"], Infinity],
    ["zero metric ID", ["metricId"], 0],
    ["uint32 metric ID overflow", ["metricId"], 4294967296],
    ["NONE comparison", ["config", "condition", "comparison"], 0],
    ["fractional threshold", ["config", "condition", "lower"], 3200.5],
    ["int32 threshold overflow", ["config", "condition", "lower"], 2147483648],
    ["non-range upper bound", ["config", "condition", "upper"], 1],
    ["zero liveness", ["config", "times", "assertionLiveness"], 0],
    ["empty betting window", ["config", "times", "closeAt"], START - 120],
    ["betting after observation start", ["config", "times", "closeAt"], START + 1],
    ["empty observation window", ["config", "times", "observationEnd"], START],
    ["early assertion", ["config", "times", "earliestAssertionAt"], START + 86399],
    ["no proposal window", ["config", "times", "proposalCutoff"], START + 86460],
    ["insufficient settlement buffer", ["config", "times", "refundAt"], START + 90060],
    ["liveness below the 60 s minimum", ["config", "times", "assertionLiveness"], 59],
    ["a settle window one second short of an hour", ["config", "times", "refundAt"], START + 90000 + 60 + 3599],
  ] as Array<[string, string[], unknown]>)("rejects %s", (_name, path, value) => {
    const { input, context } = fixture();
    expect(() => buildNumericMarketRules(input, changeAt(context, path, value))).toThrow();
  });

  it("accepts the minimum liveness with exactly a one-hour settle window", () => {
    const { input, context } = fixture();
    context.config.times.refundAt = START + 90000 + 60 + 3600;
    checkBuilt(input, context);
  });

  it.each([
    ["inverted bounds", { minValue: 10, maxValue: 0 }],
    ["int32 overflow", { maxValue: 2147483648 }],
    ["zero step", { valueStep: 0 }],
    ["uint32 step overflow", { valueStep: 4294967296 }],
    ["positive interval without a step multiple", { minValue: 1, maxValue: 9, valueStep: 10 }],
    ["negative interval without a step multiple", { minValue: -9, maxValue: -1, valueStep: 10 }],
    ["TRACE in a non-rainfall unit", { allowsTrace: true }],
    ["TRACE interval excluding zero", { unit: "mm", minValue: 1, allowsTrace: true }],
    ["TRACE interval excluding 0.05 mm", { unit: "mm", minValue: 0, maxValue: 4, allowsTrace: true }],
  ] as Array<[string, Partial<NumericMetricRules>]>)("rejects %s", (_name, overrides) => {
    const { input, context } = fixture(overrides);
    expect(() => buildNumericMarketRules(input, context)).toThrow();
  });

  it.each([
    ["full int32 range", { minValue: -2147483648, maxValue: 2147483647, valueStep: 1 }, 3200],
    ["uint32 maximum step with zero in range", { minValue: -10, maxValue: 10, valueStep: 4294967295 }, 0],
    ["positive endpoint step", { minValue: 1, maxValue: 10, valueStep: 10 }, 10],
    ["negative endpoint step", { minValue: -10, maxValue: -1, valueStep: 10 }, -10],
    ["valid TRACE interval", { unit: "mm", minValue: 0, maxValue: 5, valueStep: 10, allowsTrace: true }, 0],
  ] as Array<[string, Partial<NumericMetricRules>, number]>)("accepts %s", (_name, overrides, lower) => {
    const { input, context } = fixture(overrides);
    context.config.condition.lower = lower;
    checkBuilt(input, context);
  });
});
