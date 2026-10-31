import { decodeBytes32String, keccak256, toUtf8Bytes } from "ethers";
import {
  dailyExtractMonthUrl, hkDayWindow, parseCompactDate, type WeatherMetric,
} from "../weather/profile.js";
import {
  NUMERIC_METRIC_RULES_SCHEMA, buildNumericMarketRules, parseNumericMarketRules,
  type NumericMarketRules, type NumericResolutionPolicies, type NumericRulesContext,
} from "./numeric-rules.js";

export interface NumericMetricPreset {
  key: string;
  code: string;
  unit: string;
  minValue: number;
  maxValue: number;
  valueStep: number;
  allowsTrace: boolean;
  rulesDocument: string;
  rulesHash: string;
}
export interface HkoNumericRulesInput {
  title: string;
  targetDate: string;
}
export interface SportsNumericRulesInput {
  title: string;
  matchId: string;
  sport: "BASKETBALL" | "FOOTBALL";
  teamA: string;
  teamB: string;
}
export interface HkoNumericProfile {
  targetDate: string;
  weatherMetric: WeatherMetric;
}
export interface SportsNumericProfile {
  sport: "BASKETBALL" | "FOOTBALL";
  matchId: string;
  teamA: string;
  teamB: string;
  scoreScope: "INCLUDING_OVERTIME" | "REGULATION_90";
}

function preset(
  key: string, code: string, unit: string, minValue: number, maxValue: number,
  valueStep: number, allowsTrace: boolean, interpretation: string,
): NumericMetricPreset {
  const rulesDocument = JSON.stringify({
    schema: NUMERIC_METRIC_RULES_SCHEMA, code, unit, scale: 100,
    minValue, maxValue, valueStep, allowsTrace, interpretation,
  });
  return Object.freeze({
    key, code, unit, minValue, maxValue, valueStep, allowsTrace,
    rulesDocument, rulesHash: keccak256(toUtf8Bytes(rulesDocument)),
  });
}

/** Source and observation scope are committed in each market's rules. */
export const NUMERIC_METRIC_PRESETS: readonly NumericMetricPreset[] = Object.freeze([
  preset("rainfall", "TOTAL_RAINFALL", "mm", 0, 999990, 10, true,
    "Total rainfall over the market observation window, in mm. NUMERIC is the exact amount multiplied by 100, without rounding. TRACE means 0 < rainfall < 0.05 mm; kind=2,value=0 is only a placeholder, never exact zero."),
  preset("temperature", "DAILY_MAX_TEMPERATURE", "degC", -10000, 10000, 10, false,
    "Maximum temperature over the market observation window, in degrees Celsius, not mean or minimum. NUMERIC is the exact temperature multiplied by 100, without rounding. Negative values are allowed; TRACE is invalid."),
  preset("score-margin", "SCORE_MARGIN", "points", -50000, 50000, 100, false,
    "Final teamA score minus teamB score in integer points, using the ordered teams and scoreScope fixed by the market. NUMERIC is this margin multiplied by 100. Positive means teamA leads; zero is a tie. TRACE is invalid."),
  preset("goal-margin", "GOAL_MARGIN", "goals", -50000, 50000, 100, false,
    "Final teamA goals minus teamB goals in integer goals, using the ordered teams and scoreScope fixed by the market. NUMERIC is this margin multiplied by 100. Positive means teamA leads; zero is a tie. TRACE is invalid."),
]);

const matchesPreset = (codes: readonly string[], metric: { code: string; rulesHash: string }) =>
  NUMERIC_METRIC_PRESETS.some((preset) => codes.includes(preset.code)
    && preset.code === metric.code && preset.rulesHash.toLowerCase() === metric.rulesHash.toLowerCase());

/** The long-term official metrics: Observatory rainfall and maximum temperature, with their preset rules. */
export const OFFICIAL_METRIC_CODES = ["TOTAL_RAINFALL", "DAILY_MAX_TEMPERATURE"] as const;
export function isOfficialMetric(metric: { code: string; rulesHash: string }): boolean {
  return matchesPreset(OFFICIAL_METRIC_CODES, metric);
}

/** The sports demo metrics. Their results are synthetic files, so their markets stay on the local chain. */
export const SPORTS_METRIC_CODES = ["SCORE_MARGIN", "GOAL_MARGIN"] as const;
export function isSportsMetric(metric: { code: string; rulesHash: string }): boolean {
  return matchesPreset(SPORTS_METRIC_CODES, metric);
}

const HKO_DESCRIPTION = "Hong Kong Observatory headquarters; one complete Hong Kong calendar day.";
const HKO_PROCEDURE =
  "Use an authentic HTTP 200 snapshot of the official monthly Daily Extract JSON, Hong Kong Observatory headquarters group. " +
  "Select the unique targetDate row (9 strings): TOTAL_RAINFALL uses column 8; DAILY_MAX_TEMPERATURE uses column 2. " +
  "Accept available, unflagged values with one decimal place; rainfall also accepts Trace. Reject missing, malformed, duplicate or incomplete data. " +
  "For rainfall, if Mean/Total exists and all daily values are usable, verify the sum (Trace counts as zero only for this check). " +
  "Capture at/after the Hong Kong day ends. Retain complete response bytes for rawSha256; excerpt is JSON.stringify of the selected full row. " +
  "capturedAt is acquisition time. Hashes prove byte consistency, not source or capture-time authenticity.";
const HKO_POLICIES: NumericResolutionPolicies = Object.freeze({
  finality: "Use the available, unflagged daily value from the authentic captured snapshot after the complete Hong Kong day.",
  missingData: "Do not propose missing, unavailable, incomplete or invalid data; unresolved markets follow the contract refund deadline.",
  revision: "A proposal commits its captured snapshot. Later downloads or corrections do not rewrite that snapshot or a finalized outcome.",
});
const SPORTS_URI = "onchain:UmaMetricOracleAdapter.EvidencePublished.excerpt";
const SPORTS_PROCEDURE =
  "Use operator-provided synthetic RAINPOOL_SPORTS_DEMO_V1 JSON with synthetic=true and status=FINAL; scoreA/scoreB are non-negative safe integers. " +
  "Trim matchId/teamA/teamB as in the normalizer and match the committed ordered identities, sport and scoreScope. Compute (scoreA-scoreB)*100. " +
  "INCLUDING_OVERTIME includes overtime; REGULATION_90 includes stoppage time but excludes extra time and penalty shootouts. " +
  "V1 has no match timestamps: matchId assigns this synthetic demonstration to the committed observation window and does not prove actual match time. " +
  "Obtain the result file at/after observationEnd; capturedAt is acquisition time, not match time. Preserve complete original UTF-8 bytes for rawSha256 and excerpt; a UTF-8 BOM may be removed only for parsing. Never claim an actual sporting result.";
const SPORTS_POLICIES: NumericResolutionPolicies = Object.freeze({
  finality: "Use a FINAL synthetic result supplied by the operator after observationEnd, under the committed identities and scoring scope.",
  missingData: "Do not propose a missing or invalid result; unresolved markets follow the contract refund deadline.",
  revision: "A proposal commits its result bytes. Later operator revisions do not rewrite those bytes or a finalized outcome.",
});
const DEFINITION_KEYS = ["code", "unit", "minValue", "maxValue", "valueStep", "allowsTrace"] as const;

function fail(message: string): never {
  throw new Error(`numeric profile: ${message}`);
}
function exact(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${name} contains unknown field ${key}`);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) fail(`${name} is missing ${key}`);
  }
  return object;
}
function canonicalText(value: unknown, name: string, trim: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be non-empty text`);
  if (!trim && value !== value.trim()) fail(`${name} must already be trimmed`);
  return value.trim();
}
function targetDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) fail("targetDate must be YYYYMMDD");
  parseCompactDate(value);
  return value;
}
function metricPreset(code: string): NumericMetricPreset {
  const found = NUMERIC_METRIC_PRESETS.find((item) => item.code === code);
  if (!found) fail(`unsupported built-in metric profile: ${code}`);
  return found;
}
function assertMetric(rules: NumericMarketRules, expectedCode: string): void {
  const expected = metricPreset(expectedCode);
  for (const key of DEFINITION_KEYS) {
    if (rules.metric[key] !== expected[key]) fail(`metric definition mismatch: ${key}`);
  }
  if (rules.metric.scale !== 100 || rules.metric.rulesHash !== expected.rulesHash
    || rules.metric.rulesDocument !== expected.rulesDocument) fail("metric rules do not match the supported profile");
}
function assertSourceAndPolicies(
  rules: NumericMarketRules, uri: string, resultSchema: string, procedure: string,
  policies: NumericResolutionPolicies,
): void {
  if (rules.source.uri !== uri || rules.source.resultSchema !== resultSchema || rules.source.procedure !== procedure) {
    fail("source does not match the supported profile");
  }
  for (const key of ["finality", "missingData", "revision"] as const) {
    if (rules.policies[key] !== policies[key]) fail(`policy does not match the supported profile: ${key}`);
  }
}
function sportsFields(
  input: Record<string, unknown>, trim: boolean,
): SportsNumericProfile {
  if (input.sport !== "BASKETBALL" && input.sport !== "FOOTBALL") fail("unsupported sport");
  const teamA = canonicalText(input.teamA, "teamA", trim);
  const teamB = canonicalText(input.teamB, "teamB", trim);
  if (teamA === teamB) fail("teamA and teamB must be different");
  return {
    sport: input.sport,
    matchId: canonicalText(input.matchId, "matchId", trim),
    teamA, teamB,
    scoreScope: input.sport === "BASKETBALL" ? "INCLUDING_OVERTIME" : "REGULATION_90",
  };
}
function sportsDescription(profile: SportsNumericProfile): string {
  return `Ordered matchup: ${profile.teamA} vs ${profile.teamB}; ${profile.scoreScope}.`;
}

/** Profile validation supplements independent binding to chain state. */
export function assertHkoNumericProfile(rules: NumericMarketRules): HkoNumericProfile {
  const checked = parseNumericMarketRules(JSON.stringify(rules));
  if (checked.synthetic || checked.config.sourceId !== "HKO_DAILY_EXTRACT" || checked.config.subjectId !== "HKO") {
    fail("HKO requires a real HKO_DAILY_EXTRACT / HKO market");
  }
  const parameters = exact(checked.subject.parameters, ["station", "targetDate", "timezone"], "HKO parameters");
  const date = targetDate(parameters.targetDate);
  if (parameters.station !== "HKO" || parameters.timezone !== "Asia/Hong_Kong"
    || checked.subject.description !== HKO_DESCRIPTION) fail("HKO subject does not match the supported profile");
  const window = hkDayWindow(date);
  if (BigInt(checked.config.times.observationStart) !== window.start
    || BigInt(checked.config.times.observationEnd) !== window.end) fail("HKO requires the complete target Hong Kong day");
  let weatherMetric: WeatherMetric;
  if (checked.metric.code === "TOTAL_RAINFALL") weatherMetric = "TOTAL_RAINFALL_MM";
  else if (checked.metric.code === "DAILY_MAX_TEMPERATURE") weatherMetric = "DAILY_MAX_TEMPERATURE_C";
  else return fail("HKO profile supports rainfall or maximum temperature");
  assertMetric(checked, checked.metric.code);
  assertSourceAndPolicies(checked, dailyExtractMonthUrl(date), "RAINPOOL_WEATHER_EVIDENCE_V3", HKO_PROCEDURE, HKO_POLICIES);
  return { targetDate: date, weatherMetric };
}

/** Commit the question and collection procedure before the result exists. */
export function buildHkoNumericRules(input: HkoNumericRulesInput, context: NumericRulesContext): string {
  const fields = exact(input, ["title", "targetDate"], "HKO creation input");
  const date = targetDate(fields.targetDate);
  const metric = metricPreset(decodeBytes32String(context.metric.code));
  const document = buildNumericMarketRules({
    title: fields.title as string,
    synthetic: false,
    source: { uri: dailyExtractMonthUrl(date), resultSchema: "RAINPOOL_WEATHER_EVIDENCE_V3", procedure: HKO_PROCEDURE },
    subject: {
      description: HKO_DESCRIPTION,
      parameters: { station: "HKO", targetDate: date, timezone: "Asia/Hong_Kong" },
    },
    policies: HKO_POLICIES,
    metricRulesDocument: metric.rulesDocument,
  }, context);
  assertHkoNumericProfile(parseNumericMarketRules(document));
  return document;
}

/** Check the synthetic procedure and team order, not result authenticity. */
export function assertSportsNumericProfile(rules: NumericMarketRules): SportsNumericProfile {
  const checked = parseNumericMarketRules(JSON.stringify(rules));
  const parameters = exact(
    checked.subject.parameters, ["matchId", "sport", "teamA", "teamB", "scoreScope"], "sports parameters",
  );
  const profile = sportsFields(parameters, false);
  const basketball = profile.sport === "BASKETBALL";
  if (!checked.synthetic || checked.config.sourceId !== (basketball ? "DEMO_BASKETBALL" : "DEMO_FOOTBALL")
    || checked.config.subjectId !== profile.matchId) fail("sports source or match identity mismatch");
  if (parameters.scoreScope !== profile.scoreScope || checked.subject.description !== sportsDescription(profile)) {
    fail("sports order or scoring scope mismatch");
  }
  assertMetric(checked, basketball ? "SCORE_MARGIN" : "GOAL_MARGIN");
  assertSourceAndPolicies(checked, SPORTS_URI, "RAINPOOL_SPORTS_DEMO_V1", SPORTS_PROCEDURE, SPORTS_POLICIES);
  return profile;
}

/** Commit match identity and scoring scope; result bytes arrive after observation. */
export function buildSportsNumericRules(input: SportsNumericRulesInput, context: NumericRulesContext): string {
  const fields = exact(input, ["title", "matchId", "sport", "teamA", "teamB"], "sports creation input");
  const profile = sportsFields(fields, true);
  const metric = metricPreset(profile.sport === "BASKETBALL" ? "SCORE_MARGIN" : "GOAL_MARGIN");
  const document = buildNumericMarketRules({
    title: fields.title as string,
    synthetic: true,
    source: { uri: SPORTS_URI, resultSchema: "RAINPOOL_SPORTS_DEMO_V1", procedure: SPORTS_PROCEDURE },
    subject: { description: sportsDescription(profile), parameters: { ...profile } },
    policies: SPORTS_POLICIES,
    metricRulesDocument: metric.rulesDocument,
  }, context);
  assertSportsNumericProfile(parseNumericMarketRules(document));
  return document;
}
