// Custom markets use any registered metric except the two official ones.
// Any comparison and any valid observation window are allowed. The policies are fixed.
// The rules name the source, its URL and the reading procedure.
// A market on an HKO Daily Extract column also names the day and the column. Its reading can then be automated.

import { encodeBytes32String, keccak256, toUtf8Bytes } from "ethers";
import { dailyExtractMonthUrl, hkDayWindow, parseCompactDate } from "../weather/profile.js";
import { OFFICIAL_METRIC_CODES } from "./numeric-profiles.js";
import {
  NUMERIC_METRIC_RULES_SCHEMA, buildNumericMarketRules, parseNumericMarketRules, parseNumericMetricRulesDocument,
  type NumericChainInteger, type NumericMarketRules, type NumericMetricDefinition, type NumericResolutionPolicies,
  type NumericRulesContext,
} from "./numeric-rules.js";

/** This result schema marks custom rules. The creator's procedure says how to read the source. */
export const CUSTOM_RESULT_SCHEMA = "RAINPOOL_CUSTOM_SOURCE";
export const CUSTOM_POLICIES: NumericResolutionPolicies = Object.freeze({
  finality: "Use the value the committed source publishes for the committed observation window, read by the committed procedure after the window ends.",
  missingData: "Do not propose missing, unavailable, ambiguous or invalid data; unresolved markets follow the contract refund deadline.",
  revision: "A proposal commits the exact imported source bytes. Later corrections or downloads do not rewrite those bytes or a finalized outcome.",
});
export const MAX_SOURCE_NAME_BYTES = 128;
/** A market's rules embed its metric's rules document. The total must fit in 4096 bytes. */
export const MAX_CUSTOM_METRIC_DOCUMENT_BYTES = 1536;

export interface CustomMetricInput {
  code: string;
  unit: string;
  /** Fixed-point integers ×100. The registry stores them this way. */
  minValue: number;
  maxValue: number;
  valueStep: number;
  allowsTrace: boolean;
  interpretation: string;
}

export interface CustomMetric {
  definition: NumericMetricDefinition;
  rulesDocument: string;
  rulesHash: string;
}

function fail(message: string): never {
  throw new Error(`custom market: ${message}`);
}

function plainText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be non-empty text`);
  if (value !== value.trim()) fail(`${name} must not start or end with whitespace`);
  // eslint-disable-next-line no-control-regex -- Labels and links must not hide control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail(`${name} must not contain control characters`);
  if (toUtf8Bytes(value).length > maxBytes) fail(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

/** The registry's rules document for a custom metric. The field order matches the built-in presets. */
export function customMetricRulesDocument(input: CustomMetricInput): CustomMetric {
  const rulesDocument = JSON.stringify({
    schema: NUMERIC_METRIC_RULES_SCHEMA, code: input.code, unit: input.unit, scale: 100,
    minValue: input.minValue, maxValue: input.maxValue, valueStep: input.valueStep,
    allowsTrace: input.allowsTrace, interpretation: input.interpretation,
  });
  if (toUtf8Bytes(rulesDocument).length > MAX_CUSTOM_METRIC_DOCUMENT_BYTES) {
    fail(`metric rules exceed ${MAX_CUSTOM_METRIC_DOCUMENT_BYTES} UTF-8 bytes; shorten the definition`);
  }
  const checked = parseNumericMetricRulesDocument(rulesDocument);
  if (checked.interpretation !== checked.interpretation.trim()) fail("the definition must not start or end with whitespace");
  const { code, unit, minValue, maxValue, valueStep, allowsTrace } = checked;
  return {
    definition: { code, unit, minValue, maxValue, valueStep, allowsTrace },
    rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)),
  };
}

export interface RegisteredMetric {
  code: string;
  unit: string;
  minValue: NumericChainInteger;
  maxValue: NumericChainInteger;
  valueStep: NumericChainInteger;
  allowsTrace: boolean;
  rulesHash: string;
}

const asText = (value: string) => (/^0x[0-9a-fA-F]{64}$/.test(value) ? value : encodeBytes32String(value));

export function findMetricRulesDocument(metric: RegisteredMetric, candidates: Iterable<string>): string | undefined {
  for (const candidate of candidates) {
    if (keccak256(toUtf8Bytes(candidate)).toLowerCase() !== metric.rulesHash.toLowerCase()) continue;
    try {
      const parsed = parseNumericMetricRulesDocument(candidate);
      if (asText(metric.code).toLowerCase() === encodeBytes32String(parsed.code).toLowerCase()
        && asText(metric.unit).toLowerCase() === encodeBytes32String(parsed.unit).toLowerCase()
        && BigInt(metric.minValue) === BigInt(parsed.minValue) && BigInt(metric.maxValue) === BigInt(parsed.maxValue)
        && BigInt(metric.valueStep) === BigInt(parsed.valueStep) && metric.allowsTrace === parsed.allowsTrace) return candidate;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return undefined;
}

/** Turns a free-text label into an on-chain identifier. It keeps A–Z, 0–9 and underscores, up to 31 characters. */
export function identifierFromText(text: string, fallback: string): string {
  const id = text.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 31).replace(/_+$/, "");
  return id || fallback;
}

export interface HkoDailyExtractField {
  key: "mean-pressure" | "mean-temperature" | "min-temperature" | "mean-dew-point" | "mean-humidity" | "mean-cloud";
  /** Index in the row of nine strings. Index 0 is the day. */
  column: 1 | 3 | 4 | 5 | 6 | 7;
  header: string;
  /** "decimal": one decimal place, sign allowed. "percent": a whole percent from 0 to 100. */
  format: "decimal" | "percent";
  metric: CustomMetric;
}

export const HKO_FIELD_SOURCE_NAME = "Hong Kong Observatory Daily Extract";

function hkoField(
  key: HkoDailyExtractField["key"], column: HkoDailyExtractField["column"], header: string,
  format: HkoDailyExtractField["format"], code: string, unit: string, minValue: number, maxValue: number,
  valueStep: number, interpretation: string,
): HkoDailyExtractField {
  return Object.freeze({
    key, column, header, format,
    metric: customMetricRulesDocument({ code, unit, minValue, maxValue, valueStep, allowsTrace: false, interpretation }),
  });
}

/**
 * Fields from the same Daily Extract row as the official metrics. Each is a custom metric with a fixed definition.
 * Sepolia markets use the first three. Their documents must not change. The monthly file has no sunshine or wind.
 */
export const HKO_DAILY_EXTRACT_FIELDS: readonly HkoDailyExtractField[] = Object.freeze([
  hkoField("min-temperature", 4, "Absolute Daily Min (deg. C)", "decimal", "DAILY_MIN_TEMPERATURE", "degC", -10000, 10000, 10,
    "Minimum temperature over the market observation window, in degrees Celsius, as the HKO Daily Extract column Absolute Daily Min (deg. C) reports it. NUMERIC is the exact temperature multiplied by 100, without rounding. Negative values are allowed; TRACE is invalid."),
  hkoField("mean-temperature", 3, "Mean (deg. C)", "decimal", "DAILY_MEAN_TEMPERATURE", "degC", -10000, 10000, 10,
    "Mean temperature over the market observation window, in degrees Celsius, as the HKO Daily Extract column Mean (deg. C) reports it. NUMERIC is the exact temperature multiplied by 100, without rounding. Negative values are allowed; TRACE is invalid."),
  hkoField("mean-humidity", 6, "Mean Relative Humidity (%)", "percent", "DAILY_MEAN_HUMIDITY", "%", 0, 10000, 100,
    "Mean relative humidity over the market observation window, in percent, as the HKO Daily Extract column Mean Relative Humidity (%) reports it. HKO publishes whole percents; NUMERIC is that value multiplied by 100. TRACE is invalid."),
  hkoField("mean-pressure", 1, "Mean Pressure (hPa)", "decimal", "DAILY_MEAN_PRESSURE", "hPa", 80000, 110000, 10,
    "Mean pressure over the market observation window, in hPa, as the HKO Daily Extract column Mean Pressure (hPa) reports it. NUMERIC is the exact value multiplied by 100, without rounding. TRACE is invalid."),
  hkoField("mean-dew-point", 5, "Mean Dew Point (deg. C)", "decimal", "DAILY_MEAN_DEW_POINT", "degC", -10000, 10000, 10,
    "Mean dew point over the market observation window, in degrees Celsius, as the HKO Daily Extract column Mean Dew Point (deg. C) reports it. NUMERIC is the exact value multiplied by 100, without rounding. Negative values are allowed. TRACE is invalid."),
  hkoField("mean-cloud", 7, "Mean Amount of Cloud (%)", "percent", "DAILY_MEAN_CLOUD", "%", 0, 10000, 100,
    "Mean amount of cloud over the market observation window, in percent, as the HKO Daily Extract column Mean Amount of Cloud (%) reports it. HKO publishes whole percents. NUMERIC is that value multiplied by 100. TRACE is invalid."),
]);

export function hkoFieldProcedure(field: HkoDailyExtractField): string {
  const value = field.format === "decimal"
    ? "an available, unflagged value with one decimal place, multiplied by 100"
    : "an available, unflagged whole percent from 0 to 100, multiplied by 100";
  return "Use an authentic HTTP 200 snapshot of the official monthly Daily Extract JSON, Hong Kong Observatory headquarters group. " +
    `Select the unique targetDate row (9 strings) and read column ${field.column} (${field.header}): ${value}. ` +
    "Reject missing, malformed, duplicate or incomplete data. Capture at/after the Hong Kong day ends. " +
    "Retain complete response bytes for rawSha256; excerpt is JSON.stringify of the selected full row. " +
    "capturedAt is acquisition time. Hashes prove byte consistency, not source or capture-time authenticity.";
}

export function hkoFieldOf(metric: Pick<RegisteredMetric, "rulesHash">): HkoDailyExtractField | undefined {
  return HKO_DAILY_EXTRACT_FIELDS.find((field) => field.metric.rulesHash.toLowerCase() === metric.rulesHash.toLowerCase());
}

export interface CustomNumericProfile {
  sourceName: string;
  sourceUrl: string;
  procedure: string;
  hko?: { targetDate: string; field: HkoDailyExtractField };
}

export const isCustomNumericRules = (rules: NumericMarketRules) => rules.source.resultSchema === CUSTOM_RESULT_SCHEMA;

function sourceUrl(value: string): string {
  plainText(value, "source URL", 256);
  if (/\s/.test(value) || !URL.canParse(value)) fail("the source URL must be an absolute URL, such as https://…, without spaces");
  return value;
}

export function isSourceUrl(value: string): boolean {
  try {
    sourceUrl(value);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function assertCustomNumericProfile(rules: NumericMarketRules): CustomNumericProfile {
  const checked = parseNumericMarketRules(JSON.stringify(rules));
  if (!isCustomNumericRules(checked)) fail("these rules do not use the custom source schema");
  if (checked.synthetic) fail("custom markets name a real source, not synthetic data");
  if ((OFFICIAL_METRIC_CODES as readonly string[]).includes(checked.metric.code)) {
    fail(`${checked.metric.code} is an official metric; its markets use the official profile`);
  }
  for (const key of ["finality", "missingData", "revision"] as const) {
    if (checked.policies[key] !== CUSTOM_POLICIES[key]) fail(`policy does not match the custom profile: ${key}`);
  }
  const profile: CustomNumericProfile = {
    sourceName: plainText(checked.subject.description, "source name", MAX_SOURCE_NAME_BYTES),
    sourceUrl: sourceUrl(checked.source.uri),
    procedure: checked.source.procedure,
  };
  const parameters = checked.subject.parameters;
  const keys = Object.keys(parameters).sort().join(",");
  if (keys === "") return profile;
  if (keys !== "column,station,targetDate,timezone") fail("custom parameters are empty, or name one HKO Daily Extract field");
  const field = hkoFieldOf(checked.metric);
  const date = parameters.targetDate ?? "";
  if (!/^\d{8}$/.test(date)) fail("targetDate must be YYYYMMDD");
  parseCompactDate(date);
  const window = hkDayWindow(date);
  if (!field || parameters.column !== String(field.column) || parameters.station !== "HKO"
    || parameters.timezone !== "Asia/Hong_Kong" || checked.config.sourceId !== "HKO_DAILY_EXTRACT"
    || checked.config.subjectId !== "HKO" || profile.sourceName !== HKO_FIELD_SOURCE_NAME
    || profile.sourceUrl !== dailyExtractMonthUrl(date) || profile.procedure !== hkoFieldProcedure(field)) {
    fail("the HKO Daily Extract field, source or procedure does not match the registered field");
  }
  if (BigInt(checked.config.times.observationStart) !== window.start || BigInt(checked.config.times.observationEnd) !== window.end) {
    fail("an HKO Daily Extract field covers the complete target Hong Kong day");
  }
  return { ...profile, hko: { targetDate: date, field } };
}

export interface CustomMarketRulesInput {
  title: string;
  sourceName: string;
  sourceUrl: string;
  procedure: string;
  metricRulesDocument: string;
}

export function buildCustomNumericRules(input: CustomMarketRulesInput, context: NumericRulesContext): string {
  const document = buildNumericMarketRules({
    title: input.title,
    synthetic: false,
    source: { uri: sourceUrl(input.sourceUrl), resultSchema: CUSTOM_RESULT_SCHEMA, procedure: input.procedure },
    subject: { description: plainText(input.sourceName, "source name", MAX_SOURCE_NAME_BYTES), parameters: {} },
    policies: CUSTOM_POLICIES,
    metricRulesDocument: input.metricRulesDocument,
  }, context);
  assertCustomNumericProfile(parseNumericMarketRules(document));
  return document;
}

export function buildHkoFieldNumericRules(input: { title: string; targetDate: string }, context: NumericRulesContext): string {
  const field = hkoFieldOf(context.metric);
  if (!field) fail("the market's metric is not a registered HKO Daily Extract field");
  parseCompactDate(input.targetDate);
  const document = buildNumericMarketRules({
    title: input.title,
    synthetic: false,
    source: { uri: dailyExtractMonthUrl(input.targetDate), resultSchema: CUSTOM_RESULT_SCHEMA, procedure: hkoFieldProcedure(field) },
    subject: {
      description: HKO_FIELD_SOURCE_NAME,
      parameters: { station: "HKO", targetDate: input.targetDate, timezone: "Asia/Hong_Kong", column: String(field.column) },
    },
    policies: CUSTOM_POLICIES,
    metricRulesDocument: field.metric.rulesDocument,
  }, context);
  assertCustomNumericProfile(parseNumericMarketRules(document));
  return document;
}
