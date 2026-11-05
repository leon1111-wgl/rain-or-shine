import {
  Result, decodeBytes32String, encodeBytes32String, getAddress,
  keccak256, toUtf8Bytes, ZeroAddress, ZeroHash,
} from "ethers";
import { parseJsonStrict } from "../weather/strict.js";
import { marketTimeMessage, marketTimeProblems } from "./market-times.js";

export const NUMERIC_MARKET_RULES_SCHEMA = "RAINPOOL_NUMERIC_MARKET_V1";
export const NUMERIC_METRIC_RULES_SCHEMA = "RAINPOOL_NUMERIC_METRIC_V1";
export const NUMERIC_OBSERVATION_PROTOCOL = "NUMERIC_OBSERVATION_V1";
export const MAX_NUMERIC_MARKET_RULES_BYTES = 4096;
export { MIN_ASSERTION_LIVENESS, MIN_SETTLE_WINDOW } from "./market-times.js";

export interface NumericCondition {
  metricId: number;
  comparison: number;
  lower: number;
  upper: number;
}
export interface NumericPoolTimes {
  openAt: number;
  closeAt: number;
  observationStart: number;
  observationEnd: number;
  earliestAssertionAt: number;
  proposalCutoff: number;
  refundAt: number;
  assertionLiveness: number;
}
export interface NumericMarketConfig {
  proposer: string;
  sourceId: string;
  subjectId: string;
  condition: NumericCondition;
  times: NumericPoolTimes;
}
export interface NumericMetricDefinition {
  code: string;
  unit: string;
  minValue: number;
  maxValue: number;
  valueStep: number;
  allowsTrace: boolean;
}
export interface NumericMetricRules extends NumericMetricDefinition {
  schema: typeof NUMERIC_METRIC_RULES_SCHEMA;
  scale: 100;
  interpretation: string;
}
export interface NumericMarketMetric extends NumericMetricDefinition {
  scale: 100;
  rulesHash: string;
  rulesDocument: string;
}
export interface NumericSourceRules {
  uri: string;
  resultSchema: string;
  procedure: string;
}
export interface NumericSubjectRules {
  description: string;
  parameters: Record<string, string>;
}
export interface NumericResolutionPolicies {
  finality: string;
  missingData: string;
  revision: string;
}
export interface NumericMarketRules {
  schema: typeof NUMERIC_MARKET_RULES_SCHEMA;
  protocol: typeof NUMERIC_OBSERVATION_PROTOCOL;
  title: string;
  synthetic: boolean;
  config: NumericMarketConfig;
  metric: NumericMarketMetric;
  source: NumericSourceRules;
  subject: NumericSubjectRules;
  policies: NumericResolutionPolicies;
}
export interface NumericMarketRulesInput {
  title: string;
  synthetic: boolean;
  source: NumericSourceRules;
  subject: NumericSubjectRules;
  policies: NumericResolutionPolicies;
  metricRulesDocument: string;
}
export type NumericChainInteger = number | bigint;
export type NumericChainCondition = { [K in keyof NumericCondition]: NumericChainInteger };
export type NumericChainPoolTimes = { [K in keyof NumericPoolTimes]: NumericChainInteger };
export interface NumericChainMarketConfig {
  proposer: string;
  sourceId: string;
  subjectId: string;
  condition: NumericChainCondition;
  times: NumericChainPoolTimes;
}
export interface NumericChainMetricDefinition {
  code: string;
  unit: string;
  minValue: NumericChainInteger;
  maxValue: NumericChainInteger;
  valueStep: NumericChainInteger;
  allowsTrace: boolean;
  rulesHash: string;
}
export interface NumericRulesContext {
  config: NumericChainMarketConfig;
  metricId: NumericChainInteger;
  metric: NumericChainMetricDefinition;
}
export interface NumericRulesChainExpectation extends NumericRulesContext {
  marketRulesHash: string;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const UINT32_MAX = 4294967295;
const CONFIG_KEYS = ["proposer", "sourceId", "subjectId", "condition", "times"] as const;
const CONDITION_KEYS = ["metricId", "comparison", "lower", "upper"] as const;
const TIME_KEYS = [
  "openAt", "closeAt", "observationStart", "observationEnd",
  "earliestAssertionAt", "proposalCutoff", "refundAt", "assertionLiveness",
] as const;
const DEFINITION_KEYS = ["code", "unit", "minValue", "maxValue", "valueStep", "allowsTrace"] as const;
const MARKET_KEYS = [
  "schema", "protocol", "title", "synthetic", "config", "metric", "source", "subject", "policies",
] as const;
const INPUT_KEYS = [
  "title", "synthetic", "source", "subject", "policies", "metricRulesDocument",
] as const;
const FORBIDDEN_PARAMETER_KEYS = new Set([
  "__proto__", "constructor", "prototype", "value", "value100", "valueText",
  "reading", "result", "scoreA", "scoreB", "rawSha256", "expectedFixtureSha256",
  "fixture", "dataMode",
].map((key) => key.toLowerCase()));

function fail(message: string): never {
  throw new Error(`numeric rules: ${message}`);
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  const result = object(value, name);
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) fail(`${name} contains unknown field ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) fail(`${name} is missing ${key}`);
  }
  return result;
}
function bytesLength(value: string, name: string): number {
  try { return toUtf8Bytes(value).length; }
  catch { return fail(`${name} must be valid UTF-8 text`); }
}
function text(value: unknown, name: string, maxBytes = MAX_NUMERIC_MARKET_RULES_BYTES): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be non-empty text`);
  if (bytesLength(value, name) > maxBytes) fail(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} must be a boolean`);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number, fromChain = false): number {
  if (fromChain && typeof value === "bigint") {
    if (value < BigInt(min) || value > BigInt(max)) fail(`${name} is out of range`);
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be a safe integer in ${min}..${max}`);
  }
  return value;
}
function identifier(value: unknown, name: string): string {
  const result = text(value, name, 31);
  // eslint-disable-next-line no-control-regex -- Reject C0/C1 control characters in identifiers.
  if (result !== result.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) {
    fail(`${name} must not contain control characters or surrounding whitespace`);
  }
  try { encodeBytes32String(result); }
  catch { return fail(`${name} must fit a bytes32 text identifier`); }
  return result;
}
function chainIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail(`${name} must be bytes32`);
  let decoded: string;
  try { decoded = decodeBytes32String(value); }
  catch { return fail(`${name} must encode a valid bytes32 text identifier`); }
  const result = identifier(decoded, name);
  if (encodeBytes32String(result).toLowerCase() !== value.toLowerCase()) {
    fail(`${name} has noncanonical bytes32 padding`);
  }
  return result;
}
function address(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} must be an address`);
  let result: string;
  try { result = getAddress(value); }
  catch { return fail(`${name} must be a valid address`); }
  if (result === ZeroAddress) fail(`${name} must not be the zero address`);
  return result;
}
function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || value.toLowerCase() === ZeroHash) {
    fail(`${name} must be a nonzero bytes32 hash`);
  }
  return value.toLowerCase();
}
function fields(value: unknown, keys: readonly string[], name: string, fromChain: boolean): Record<string, unknown> {
  // Ethers named tuples are Result arrays. Rule JSON must remain plain objects.
  if (fromChain && value instanceof Result) return value as unknown as Record<string, unknown>;
  return exact(value, keys, name);
}

function condition(value: unknown, fromChain: boolean): NumericCondition {
  const c = fields(value, CONDITION_KEYS, "condition", fromChain);
  const result = {
    metricId: integer(c.metricId, "metricId", 1, UINT32_MAX, fromChain),
    comparison: integer(c.comparison, "comparison", 1, 5, fromChain),
    lower: integer(c.lower, "lower", INT32_MIN, INT32_MAX, fromChain),
    upper: integer(c.upper, "upper", INT32_MIN, INT32_MAX, fromChain),
  };
  if (result.comparison === 5) {
    if (result.lower > result.upper) fail("RANGE requires lower <= upper");
  } else if (result.upper !== 0) fail("non-RANGE comparison requires upper = 0");
  return result;
}
/** ConditionLib's TRACE check: TRACE is the open interval (0, 5) in value100 units. */
export function traceDecides(c: Pick<NumericCondition, "comparison" | "lower" | "upper">): boolean {
  return c.comparison === 5
    ? c.upper <= 0 || c.lower >= 5 || (c.lower <= 0 && c.upper >= 5)
    : c.lower <= 0 || c.lower >= 5;
}
export type ConditionProblem = "RANGE_ORDER" | "OUTSIDE_RANGE" | "OFF_STEP" | "TRACE_UNDECIDABLE";
const CONDITION_MESSAGES: Record<ConditionProblem, string> = {
  RANGE_ORDER: "RANGE requires lower <= upper",
  OUTSIDE_RANGE: "condition threshold is outside the metric range",
  OFF_STEP: "condition threshold does not match the metric step",
  TRACE_UNDECIDABLE: "TRACE cannot decide this condition",
};
/** Every rule the condition breaks for this metric. Comparison 5 is the inclusive range [lower, upper]. */
export function conditionProblems(
  c: Pick<NumericCondition, "comparison" | "lower" | "upper">,
  m: Pick<NumericMetricDefinition, "minValue" | "maxValue" | "valueStep" | "allowsTrace">,
): ConditionProblem[] {
  const thresholds = c.comparison === 5 ? [c.lower, c.upper] : [c.lower];
  const problems: ConditionProblem[] = [];
  if (c.comparison === 5 && c.lower > c.upper) problems.push("RANGE_ORDER");
  if (thresholds.some((threshold) => threshold < m.minValue || threshold > m.maxValue)) problems.push("OUTSIDE_RANGE");
  if (thresholds.some((threshold) => threshold % m.valueStep !== 0)) problems.push("OFF_STEP");
  if (m.allowsTrace && !traceDecides(c)) problems.push("TRACE_UNDECIDABLE");
  return problems;
}
/** Mirror ConditionLib.validateForMetric, which createMarket applies. */
function conditionFitsMetric(c: NumericCondition, m: NumericMetricDefinition): void {
  const [problem] = conditionProblems(c, m);
  if (problem) fail(CONDITION_MESSAGES[problem]);
}
function times(value: unknown, fromChain: boolean): NumericPoolTimes {
  const t = fields(value, TIME_KEYS, "times", fromChain);
  const result = {} as NumericPoolTimes;
  for (const key of TIME_KEYS) result[key] = integer(t[key], key, 1, Number.MAX_SAFE_INTEGER, fromChain);
  // Historical rule validity must not depend on the current wall clock, so no current time is passed.
  const [problem] = marketTimeProblems(result);
  if (problem) fail(marketTimeMessage(problem));
  return result;
}
function config(value: unknown, fromChain: boolean): NumericMarketConfig {
  const c = fields(value, CONFIG_KEYS, "config", fromChain);
  const id = fromChain ? chainIdentifier : identifier;
  return {
    proposer: address(c.proposer, "proposer"),
    sourceId: id(c.sourceId, "sourceId"),
    subjectId: id(c.subjectId, "subjectId"),
    condition: condition(c.condition, fromChain),
    times: times(c.times, fromChain),
  };
}
function definition(d: Record<string, unknown>, fromChain: boolean): NumericMetricDefinition {
  const id = fromChain ? chainIdentifier : identifier;
  const result = {
    code: id(d.code, "metric.code"),
    unit: id(d.unit, "metric.unit"),
    minValue: integer(d.minValue, "metric.minValue", INT32_MIN, INT32_MAX, fromChain),
    maxValue: integer(d.maxValue, "metric.maxValue", INT32_MIN, INT32_MAX, fromChain),
    valueStep: integer(d.valueStep, "metric.valueStep", 1, UINT32_MAX, fromChain),
    allowsTrace: bool(d.allowsTrace, "metric.allowsTrace"),
  };
  if (result.minValue > result.maxValue) fail("metric range requires minValue <= maxValue");
  const min = BigInt(result.minValue);
  const step = BigInt(result.valueStep);
  let first = (min / step) * step;
  if (first < min) first += step;
  if (first > BigInt(result.maxValue)) fail("metric range contains no valid step multiple");
  if (result.allowsTrace && (result.unit !== "mm" || result.minValue > 0 || result.maxValue < 5)) {
    fail("TRACE requires unit mm and a metric range covering 0..5");
  }
  return result;
}
function sameDefinition(actual: NumericMetricDefinition, expected: NumericMetricDefinition, name: string): void {
  for (const key of DEFINITION_KEYS) {
    if (actual[key] !== expected[key]) fail(`${name} mismatch: ${key}`);
  }
}
export function parseNumericMetricRulesDocument(document: string): NumericMetricRules {
  text(document, "metric rules document");
  const inner = exact(
    parseJsonStrict(document),
    [...DEFINITION_KEYS, "schema", "scale", "interpretation"],
    "metric rules document",
  );
  if (inner.schema !== NUMERIC_METRIC_RULES_SCHEMA) fail("unsupported metric rules schema");
  if (inner.scale !== 100) fail("metric rules scale must be 100");
  return {
    ...definition(inner, false), schema: NUMERIC_METRIC_RULES_SCHEMA, scale: 100,
    interpretation: text(inner.interpretation, "metric interpretation"),
  };
}
function metric(value: unknown): NumericMarketMetric {
  const m = exact(value, [...DEFINITION_KEYS, "scale", "rulesHash", "rulesDocument"], "metric");
  if (m.scale !== 100) fail("metric.scale must be 100");
  const normalized = definition(m, false);
  const rulesDocument = text(m.rulesDocument, "metric rules document");
  const rulesHash = hash(m.rulesHash, "metric rulesHash");
  // Commit exact source text, without trimming or JSON reserialization.
  if (keccak256(toUtf8Bytes(rulesDocument)) !== rulesHash) fail("metric rules hash mismatch");
  sameDefinition(parseNumericMetricRulesDocument(rulesDocument), normalized, "metric rules definition");
  return { ...normalized, scale: 100, rulesHash, rulesDocument };
}
function source(value: unknown): NumericSourceRules {
  const s = exact(value, ["uri", "resultSchema", "procedure"], "source");
  return {
    uri: text(s.uri, "source.uri", 256),
    resultSchema: text(s.resultSchema, "source.resultSchema"),
    procedure: text(s.procedure, "source.procedure"),
  };
}
function subject(value: unknown): NumericSubjectRules {
  const s = exact(value, ["description", "parameters"], "subject");
  const p = object(s.parameters, "subject.parameters");
  const keys = Object.keys(p).sort();
  if (keys.length > 16) fail("subject.parameters allows at most 16 entries");
  const parameters: Record<string, string> = {};
  for (const key of keys) {
    if (!/^[\x21-\x7e]{1,32}$/.test(key)) fail("parameter keys must be 1..32 printable ASCII characters");
    if (FORBIDDEN_PARAMETER_KEYS.has(key.toLowerCase())) fail(`result / reserved parameter key is forbidden: ${key}`);
    parameters[key] = text(p[key], `subject.parameters.${key}`, 128);
  }
  // Block accidental result fields. Free text cannot be checked for advance knowledge.
  return { description: text(s.description, "subject.description"), parameters };
}
function policies(value: unknown): NumericResolutionPolicies {
  const p = exact(value, ["finality", "missingData", "revision"], "policies");
  return {
    finality: text(p.finality, "policies.finality"),
    missingData: text(p.missingData, "policies.missingData"),
    revision: text(p.revision, "policies.revision"),
  };
}

/** Check internal consistency, not onchain commitment or source authenticity. */
export function parseNumericMarketRules(document: string): NumericMarketRules {
  text(document, "market rules document");
  const d = exact(parseJsonStrict(document), MARKET_KEYS, "market rules");
  if (d.schema !== NUMERIC_MARKET_RULES_SCHEMA) fail("unsupported market rules schema");
  if (d.protocol !== NUMERIC_OBSERVATION_PROTOCOL) fail("unsupported observation protocol");
  const rules: NumericMarketRules = {
    schema: NUMERIC_MARKET_RULES_SCHEMA,
    protocol: NUMERIC_OBSERVATION_PROTOCOL,
    title: text(d.title, "title", 240),
    synthetic: bool(d.synthetic, "synthetic"),
    config: config(d.config, false),
    metric: metric(d.metric),
    source: source(d.source),
    subject: subject(d.subject),
    policies: policies(d.policies),
  };
  conditionFitsMetric(rules.config.condition, rules.metric);
  return rules;
}
function context(value: unknown, withMarketHash = false) {
  const c = exact(
    value, withMarketHash ? ["config", "metricId", "metric", "marketRulesHash"] : ["config", "metricId", "metric"],
    "chain context",
  );
  const normalizedConfig = config(c.config, true);
  const metricId = integer(c.metricId, "context.metricId", 1, UINT32_MAX, true);
  if (metricId !== normalizedConfig.condition.metricId) fail("context.metricId does not match config.condition.metricId");
  const m = fields(c.metric, [...DEFINITION_KEYS, "rulesHash"], "chain metric", true);
  const normalizedMetric = { ...definition(m, true), rulesHash: hash(m.rulesHash, "chain metric rulesHash") };
  conditionFitsMetric(normalizedConfig.condition, normalizedMetric);
  return { config: normalizedConfig, metric: normalizedMetric };
}
export function buildNumericMarketRules(input: NumericMarketRulesInput, chainContext: NumericRulesContext): string {
  const i = exact(input, INPUT_KEYS, "market rules input");
  const c = context(chainContext);
  const document = JSON.stringify({
    schema: NUMERIC_MARKET_RULES_SCHEMA,
    protocol: NUMERIC_OBSERVATION_PROTOCOL,
    title: text(i.title, "title", 240),
    synthetic: bool(i.synthetic, "synthetic"),
    config: c.config,
    metric: metric({ ...c.metric, scale: 100, rulesDocument: i.metricRulesDocument }),
    source: source(i.source),
    subject: subject(i.subject),
    policies: policies(i.policies),
  });
  parseNumericMarketRules(document);
  return document;
}
/** Bind exact text and configuration to independently read chain expectations. */
export function assertNumericMarketRulesMatchChain(
  document: string, expected: NumericRulesChainExpectation,
): NumericMarketRules {
  const rules = parseNumericMarketRules(document);
  const c = context(expected, true);
  if (keccak256(toUtf8Bytes(document)) !== hash(expected.marketRulesHash, "marketRulesHash")) {
    fail("market rules hash mismatch");
  }
  for (const key of ["proposer", "sourceId", "subjectId"] as const) {
    if (rules.config[key] !== c.config[key]) fail(`chain config mismatch: ${key}`);
  }
  for (const key of CONDITION_KEYS) {
    if (rules.config.condition[key] !== c.config.condition[key]) fail(`chain condition mismatch: ${key}`);
  }
  for (const key of TIME_KEYS) {
    if (rules.config.times[key] !== c.config.times[key]) fail(`chain times mismatch: ${key}`);
  }
  sameDefinition(rules.metric, c.metric, "chain metric definition");
  if (rules.metric.rulesHash !== c.metric.rulesHash) fail("chain metric rulesHash mismatch");
  return rules;
}
