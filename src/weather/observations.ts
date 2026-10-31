import { sha256 } from "ethers";
import { checkDailyExtractRainfallTotal, readDailyExtractDay, type RawEvidence } from "./parse.js";
import {
  DEMO_OBSERVATION_PROFILE,
  HKO_DAILY_EXTRACT_PROFILE,
  HKO_WEATHER_METRICS,
  OBSERVATION_PARSER_VERSION,
  hkDayWindow,
  toCompactDate,
  type WeatherObservationMode,
  type WeatherMetric,
} from "./profile.js";
import { WeatherDataError, decodeUtf8, parseJsonStrict, parseRainfallToken, parseTemperatureToken } from "./strict.js";

export type { WeatherMetric } from "./profile.js";

export const MAX_DEMO_OBSERVATION_BYTES = 512;

/** V2 uses signed fixed-point integers; Trace deliberately has no exact value. */
export interface WeatherObservation {
  schemaVersion: 2;
  mode: WeatherObservationMode;
  sourceId: string;
  stationId: string;
  targetDate: string;
  timezone: "Asia/Hong_Kong";
  windowStart: string;
  windowEnd: string;
  metric: WeatherMetric;
  unit: "mm" | "degC";
  scale: 100;
  kind: "NUMERIC" | "TRACE";
  value: number | null;
  valueText: string;
  excerpt: string;
  sourceURL: string;
  fetchedAt: string | null;
  lastModified: string | null;
  rawSha256: string;
  parserVersion: string;
}

export function weatherMetricProfile(metric: WeatherMetric): (typeof HKO_WEATHER_METRICS)[WeatherMetric] {
  if (metric !== "TOTAL_RAINFALL_MM" && metric !== "DAILY_MAX_TEMPERATURE_C") {
    throw new WeatherDataError("DATA_INVALID", `unsupported weather metric: ${String(metric)}`);
  }
  return HKO_WEATHER_METRICS[metric];
}

function parseValue(token: unknown, metric: WeatherMetric): Pick<WeatherObservation, "kind" | "value" | "valueText"> {
  if (metric === "TOTAL_RAINFALL_MM") {
    const reading = parseRainfallToken(token, "Total Rainfall (mm)");
    return { kind: reading.kind, value: reading.kind === "TRACE" ? null : reading.mm100, valueText: reading.text };
  }
  const reading = parseTemperatureToken(token, "Absolute Daily Max (deg. C)");
  return { kind: reading.kind, value: reading.celsius100, valueText: reading.text };
}

function observation(raw: RawEvidence, compact: string, metric: WeatherMetric, token: unknown, mode: WeatherObservationMode, excerpt: string): WeatherObservation {
  const profile = weatherMetricProfile(metric);
  const source = mode === "LIVE_HKO" ? HKO_DAILY_EXTRACT_PROFILE : DEMO_OBSERVATION_PROFILE;
  const window = hkDayWindow(compact);
  return {
    schemaVersion: 2,
    mode,
    sourceId: source.sourceId,
    stationId: source.stationId,
    targetDate: compact,
    timezone: "Asia/Hong_Kong",
    windowStart: window.start.toString(),
    windowEnd: window.end.toString(),
    metric,
    unit: profile.unit,
    scale: profile.scale,
    ...parseValue(token, metric),
    excerpt,
    sourceURL: raw.sourceURL,
    fetchedAt: raw.fetchedAt,
    lastModified: raw.lastModified,
    rawSha256: sha256(raw.bytes),
    parserVersion: OBSERVATION_PARSER_VERSION,
  };
}

/** Read one HKO fact. No YES/NO decision or administrator-defined threshold is involved. */
export function parseDailyExtractObservation(raw: RawEvidence, requestedDate: string, metric: WeatherMetric): WeatherObservation {
  const profile = weatherMetricProfile(metric);
  const { compactDate, row, rows } = readDailyExtractDay(raw, requestedDate);
  if (metric === "TOTAL_RAINFALL_MM") checkDailyExtractRainfallTotal(rows, compactDate.slice(0, 6));
  return observation(raw, compactDate, metric, row[profile.column.index], "LIVE_HKO", JSON.stringify(row));
}

export function parseDemoObservation(raw: RawEvidence, requestedDate: string, metric: WeatherMetric): WeatherObservation {
  const profile = weatherMetricProfile(metric);
  const compact = toCompactDate(requestedDate);
  if (raw.bytes.length > MAX_DEMO_OBSERVATION_BYTES) throw new WeatherDataError("DATA_INVALID", `demo fixture exceeds ${MAX_DEMO_OBSERVATION_BYTES} bytes`);
  const text = decodeUtf8(raw.bytes);
  const doc = parseJsonStrict(text) as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new WeatherDataError("DATA_INVALID", "fixture is not a JSON object");
  if (doc.fixtureKind !== DEMO_OBSERVATION_PROFILE.fixtureKind || doc.synthetic !== true) {
    throw new WeatherDataError("DATA_INVALID", `fixture must declare fixtureKind "${DEMO_OBSERVATION_PROFILE.fixtureKind}" and synthetic: true`);
  }
  if (doc.stationId !== DEMO_OBSERVATION_PROFILE.stationId) throw new WeatherDataError("DATA_INVALID", `fixture stationId must be "${DEMO_OBSERVATION_PROFILE.stationId}"`);
  if (doc.targetDate !== compact) throw new WeatherDataError("EVIDENCE_MISMATCH", `fixture is for ${String(doc.targetDate)}, not ${compact}`);
  if (doc.metric !== metric) throw new WeatherDataError("EVIDENCE_MISMATCH", `fixture is for ${String(doc.metric)}, not ${metric}`);
  if (doc.unit !== profile.unit || doc.scale !== profile.scale) throw new WeatherDataError("DATA_INVALID", `fixture unit or scale does not match ${metric}`);
  return observation(raw, compact, metric, doc.valueText, "DEMO_FIXTURE", text);
}

export function demoObservationText(targetDate: string, metric: WeatherMetric, valueText: string): string {
  const profile = weatherMetricProfile(metric);
  const compact = toCompactDate(targetDate);
  parseValue(valueText, metric);
  const doc = {
    fixtureKind: DEMO_OBSERVATION_PROFILE.fixtureKind,
    synthetic: true,
    notice: DEMO_OBSERVATION_PROFILE.notice,
    stationId: DEMO_OBSERVATION_PROFILE.stationId,
    targetDate: compact,
    metric,
    unit: profile.unit,
    scale: profile.scale,
    valueText,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
