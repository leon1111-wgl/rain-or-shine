import { formatFixed100, parseFixed100 } from "@shared/metric/fixed100";
import { HKO_DAILY_EXTRACT_FIELDS, hkoFieldOf, type HkoDailyExtractField } from "@shared/metric/custom-profile";
import {
  NUMERIC_METRIC_PRESETS, OFFICIAL_METRIC_CODES, SPORTS_METRIC_CODES, isOfficialMetric, isSportsMetric, type NumericMetricPreset,
} from "@shared/metric/numeric-profiles";
import { conditionProblems, type NumericMetricDefinition } from "@shared/metric/numeric-rules";
import { type MarketData, formatReading } from "../lib/markets";
import type { MetricView } from "./client";

const DAY = 86_400;
const HKT = 8 * 3_600;

export type Sport = "BASKETBALL" | "FOOTBALL";

export type MetricChoice =
  | { kind: "official"; key: string; preset: NumericMetricPreset }
  | { kind: "field"; key: string; field: HkoDailyExtractField }
  | { kind: "registered"; key: string; metric: MetricView }
  | { kind: "new"; key: "new" }
  | { kind: "sports"; key: string; preset: NumericMetricPreset; sport: Sport };

export interface MatchInput {
  matchId: string;
  teamA: string;
  teamB: string;
}

export const DEMO_MATCHES: Record<Sport, MatchInput> = {
  BASKETBALL: { matchId: "LAL_BOS_DEMO01", teamA: "LAL", teamB: "BOS" },
  FOOTBALL: { matchId: "ARS_CHE_DEMO01", teamA: "ARS", teamB: "CHE" },
};
const SPORTS: Record<string, Sport> = { SCORE_MARGIN: "BASKETBALL", GOAL_MARGIN: "FOOTBALL" };

const isOfficialCode = (code: string) => (OFFICIAL_METRIC_CODES as readonly string[]).includes(code);

export function metricChoices(registered: readonly MetricView[], demos = false): MetricChoice[] {
  const official: MetricChoice[] = NUMERIC_METRIC_PRESETS.filter((preset) => isOfficialCode(preset.code))
    .map((preset) => ({ kind: "official", key: `official:${preset.code}`, preset }));
  const fields: MetricChoice[] = [...HKO_DAILY_EXTRACT_FIELDS].sort((a, b) => a.column - b.column)
    .map((field) => ({ kind: "field", key: `field:${field.key}`, field }));
  const known = new Set(HKO_DAILY_EXTRACT_FIELDS.map((field) => field.metric.rulesHash.toLowerCase()));
  const custom: MetricChoice[] = registered
    .filter((metric) => !isOfficialCode(metric.code) && !known.has(metric.rulesHash.toLowerCase()) && !isSportsMetric(metric))
    .map((metric) => ({ kind: "registered", key: `metric:${metric.id}`, metric }));
  const sports: MetricChoice[] = !demos ? [] : NUMERIC_METRIC_PRESETS
    .filter((preset) => (SPORTS_METRIC_CODES as readonly string[]).includes(preset.code))
    .map((preset) => ({ kind: "sports", key: `sports:${preset.code}`, preset, sport: SPORTS[preset.code]! }));
  return [...official, ...fields, ...custom, { kind: "new", key: "new" }, ...sports];
}

type Definition = Pick<NumericMetricDefinition, "code" | "unit" | "minValue" | "maxValue" | "valueStep" | "allowsTrace">;

export function definitionOf(choice: MetricChoice): Definition | undefined {
  if (choice.kind === "official" || choice.kind === "sports") return choice.preset;
  if (choice.kind === "field") return choice.field.metric.definition;
  if (choice.kind === "registered") return choice.metric;
  return undefined;
}

export function rulesHashOf(choice: MetricChoice): string | undefined {
  if (choice.kind === "official" || choice.kind === "sports") return choice.preset.rulesHash;
  if (choice.kind === "field") return choice.field.metric.rulesHash;
  if (choice.kind === "registered") return choice.metric.rulesHash;
  return undefined;
}

export type Registration =
  | { state: "registered"; metric: MetricView }
  | { state: "missing" }
  | { state: "conflict"; metric: MetricView };

export function registrationOf(choice: MetricChoice, registered: readonly MetricView[], fresh?: { code: string; rulesHash?: string }): Registration {
  const code = choice.kind === "new" ? fresh?.code.trim() ?? "" : definitionOf(choice)!.code;
  const existing = code ? registered.find((metric) => metric.code === code) : undefined;
  if (!existing) return { state: "missing" };
  const hash = choice.kind === "new" ? fresh?.rulesHash : rulesHashOf(choice);
  return hash && existing.rulesHash.toLowerCase() === hash.toLowerCase() ? { state: "registered", metric: existing } : { state: "conflict", metric: existing };
}

export interface ConditionInput {
  comparison: string;
  lower: string;
  upper: string;
}

const PRESET_CONDITIONS: Record<string, ConditionInput> = {
  TOTAL_RAINFALL: { comparison: "4", lower: "1.0", upper: "" },
  DAILY_MAX_TEMPERATURE: { comparison: "4", lower: "28.0", upper: "" },
  DAILY_MIN_TEMPERATURE: { comparison: "2", lower: "22.0", upper: "" },
  DAILY_MEAN_TEMPERATURE: { comparison: "4", lower: "25.0", upper: "" },
  DAILY_MEAN_PRESSURE: { comparison: "4", lower: "1013.0", upper: "" },
  DAILY_MEAN_DEW_POINT: { comparison: "4", lower: "20.0", upper: "" },
  DAILY_MEAN_HUMIDITY: { comparison: "5", lower: "70", upper: "85" },
  DAILY_MEAN_CLOUD: { comparison: "4", lower: "60", upper: "" },
  SCORE_MARGIN: { comparison: "3", lower: "0", upper: "" },
  GOAL_MARGIN: { comparison: "3", lower: "0", upper: "" },
};
const UNIT_CONDITIONS: Record<string, ConditionInput> = {
  mm: { comparison: "4", lower: "10.0", upper: "" },
  degC: { comparison: "4", lower: "25.0", upper: "" },
  "%": { comparison: "5", lower: "70", upper: "85" },
  hPa: { comparison: "4", lower: "1013.0", upper: "" },
};

function fits(condition: ConditionInput, definition: Definition): boolean {
  try {
    const lower = parseFixed100(condition.lower);
    const upper = condition.comparison === "5" ? parseFixed100(condition.upper) : 0;
    return conditionProblems({ comparison: Number(condition.comparison), lower, upper }, definition).length === 0;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function defaultCondition(definition: Definition | undefined): ConditionInput {
  if (!definition) return { comparison: "4", lower: "", upper: "" };
  for (const candidate of [PRESET_CONDITIONS[definition.code], UNIT_CONDITIONS[definition.unit]]) {
    if (candidate && fits(candidate, definition)) return candidate;
  }
  const { minValue, maxValue, valueStep } = definition;
  const middle = Math.floor((minValue + maxValue) / 2 / valueStep) * valueStep;
  return { comparison: "4", lower: formatFixed100(Math.min(Math.max(middle, minValue), maxValue)), upper: "" };
}

const hkDate = (unix: number) => new Date((unix + HKT) * 1000).toISOString().slice(0, 10);
const hkDayStart = (date: string) => Date.parse(`${date}T00:00:00+08:00`) / 1000;

export function nextOpenDay(now: number, openDelay: number): string {
  let date = hkDate(now + DAY);
  while (hkDayStart(date) - 60 <= now + openDelay) date = hkDate(hkDayStart(date) + DAY);
  return date;
}

export interface TimingInput {
  proposalHours: string;
  liveness: string;
  bufferHours: string;
}

export interface Template {
  choiceKey: string;
  condition: ConditionInput;
  source: { name: string; url: string; procedure: string } | null;
  match: MatchInput | null;
  window: { mode: "day"; date: string } | { mode: "window"; start: number; end: number };
  timing: TimingInput;
}

export function templateOf(m: MarketData, now: number, openDelay: number): Template {
  const metric = m.view.metric;
  const field = hkoFieldOf(metric);
  const s = m.subject;
  const sports = s.kind === "SYNTHETIC" && isSportsMetric(metric) ? s : null;
  const choiceKey = isOfficialMetric(metric) ? `official:${metric.code}` : field ? `field:${field.key}` : sports ? `sports:${metric.code}` : `metric:${metric.id}`;
  const { comparison, lower, upper } = m.condition;
  const condition = { comparison: String(comparison), lower: formatReading(lower, metric), upper: comparison === 5 ? formatReading(upper, metric) : "" };
  const source = s.kind === "CUSTOM" && !field ? { name: s.sourceName, url: s.sourceUrl, procedure: s.procedure } : null;
  const match = sports ? { matchId: sports.matchId, teamA: sports.teamA, teamB: sports.teamB } : null;
  const times = m.times;
  const hours = (seconds: bigint) => String(Number(seconds) / 3_600);
  const timing = {
    proposalHours: hours(times.proposalCutoff - times.observationEnd),
    liveness: String(times.assertionLiveness),
    bufferHours: hours(times.refundAt - times.proposalCutoff - times.assertionLiveness),
  };
  const start = Number(times.observationStart);
  const end = Number(times.observationEnd);
  const wholeDay = (start + HKT) % DAY === 0 && end - start === DAY;
  if (!sports && (s.kind === "HKO" || field || wholeDay)) return { choiceKey, condition, source, match, window: { mode: "day", date: nextOpenDay(now, openDelay) }, timing };
  // A quarter of an hour of room, so the chain time at creation still finds the window open.
  let shift = Math.ceil((now + openDelay + 15 * 60 - start) / DAY) * DAY;
  if (shift < 0) shift = 0;
  return { choiceKey, condition, source, match, window: { mode: "window", start: start + shift, end: end + shift }, timing };
}
