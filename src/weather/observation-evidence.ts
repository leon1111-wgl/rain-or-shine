import { decodeBase64, encodeBase64, sha256 } from "ethers";
import { parseDailyExtractObservation, parseDemoObservation, type WeatherObservation } from "./observations.js";
import { type RawEvidence } from "./parse.js";
import { dailyExtractMonthUrl } from "./profile.js";
import { WeatherDataError } from "./strict.js";

export const OBSERVATION_BUNDLE_KIND = "RAINPOOL_WEATHER_EVIDENCE";
export const MAX_SOURCE_URL_BYTES = 256;
// Weather bundles allow 512 excerpt bytes. Proposal validation enforces the contract limit.
export const MAX_EXCERPT_BYTES = 512;

export interface EvidenceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ObservationBundle {
  kind: typeof OBSERVATION_BUNDLE_KIND;
  bundleVersion: 3;
  observation: WeatherObservation;
  raw: { base64: string; byteLength: number; contentType: string | null; httpStatus: number | null; lastModified: string | null };
  notes: string[];
}

export type ObservationEvidenceRules = Pick<
  WeatherObservation,
  "mode" | "sourceId" | "stationId" | "targetDate" | "metric" | "unit" | "scale" | "windowStart" | "windowEnd"
>;

export function buildObservationBundle(raw: RawEvidence, observation: WeatherObservation): ObservationBundle {
  return {
    kind: OBSERVATION_BUNDLE_KIND,
    bundleVersion: 3,
    observation,
    raw: {
      base64: encodeBase64(raw.bytes),
      byteLength: raw.bytes.length,
      contentType: raw.contentType,
      httpStatus: raw.httpStatus,
      lastModified: raw.lastModified,
    },
    notes: observation.mode === "LIVE_HKO"
      ? [
          "The exact HKO Daily Extract monthly response bytes are retained and re-parsed for the selected metric and day.",
          "SHA-256 proves byte consistency only; it does not authenticate the source, capture time or weather.",
          "A later monthly snapshot may differ. This bundle states an observation, not a YES/NO event outcome.",
        ]
      : [
          "DEMO_FIXTURE: synthetic data for testing, not an actual weather observation.",
          "Synthetic weather fixtures support offline data tooling; they are not admissible as real HKO observations.",
        ],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function hasBundleShape(value: unknown): value is ObservationBundle {
  if (!isObject(value) || value.kind !== OBSERVATION_BUNDLE_KIND || value.bundleVersion !== 3) return false;
  const r = value.observation;
  const raw = value.raw;
  if (!isObject(r) || !isObject(raw) || !Array.isArray(value.notes) || !value.notes.every((note) => typeof note === "string")) return false;
  if (r.schemaVersion !== 2 || (r.mode !== "LIVE_HKO" && r.mode !== "DEMO_FIXTURE")) return false;
  if (r.metric !== "TOTAL_RAINFALL_MM" && r.metric !== "DAILY_MAX_TEMPERATURE_C") return false;
  if (r.unit !== "mm" && r.unit !== "degC") return false;
  if (typeof r.scale !== "number" || !Number.isSafeInteger(r.scale)) return false;
  if (r.kind !== "NUMERIC" && r.kind !== "TRACE") return false;
  if (r.value !== null && (typeof r.value !== "number" || !Number.isSafeInteger(r.value))) return false;
  const stringFields = ["sourceId", "stationId", "targetDate", "timezone", "windowStart", "windowEnd", "valueText", "excerpt", "sourceURL", "rawSha256", "parserVersion"] as const;
  if (!stringFields.every((key) => typeof r[key] === "string")) return false;
  if (!nullableString(r.fetchedAt) || !nullableString(r.lastModified)) return false;
  if (typeof raw.base64 !== "string" || typeof raw.byteLength !== "number" || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0) return false;
  if (!nullableString(raw.contentType) || !nullableString(raw.lastModified)) return false;
  return raw.httpStatus === null || (typeof raw.httpStatus === "number" && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599);
}

/** Date.parse alone accepts local dates and normalises some invalid calendar dates. */
function captureTimeMs(value: string | null): number | null {
  if (value === null) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(hour, minute, second, 0);
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const offset = parts[8]!;
  const offsetHours = offset === "Z" ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === "Z" ? 0 : Number(offset.slice(4, 6));
  if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const OBSERVATION_FIELDS: readonly (keyof WeatherObservation)[] = [
  "schemaVersion", "mode", "sourceId", "stationId", "targetDate", "timezone", "windowStart", "windowEnd",
  "metric", "unit", "scale", "kind", "value", "valueText", "excerpt", "sourceURL", "fetchedAt", "lastModified", "rawSha256", "parserVersion",
];
const RULE_FIELDS: readonly (keyof ObservationEvidenceRules)[] = [
  "mode", "sourceId", "stationId", "targetDate", "metric", "unit", "scale", "windowStart", "windowEnd",
];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** Returns failed checks for malformed input. Only assertObservationBundle throws. */
export function checkObservationBundle(value: unknown, expected?: ObservationEvidenceRules): EvidenceCheck[] {
  const checks: EvidenceCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  if (!hasBundleShape(value)) {
    add("format", false, "not a valid RAINPOOL_WEATHER_EVIDENCE v3 bundle with a v2 observation");
    return checks;
  }
  const bundle = value;
  const observation = bundle.observation;
  add("format", true, "RAINPOOL_WEATHER_EVIDENCE v3 / weather observation v2");
  let bytes: Uint8Array;
  try {
    if (!BASE64.test(bundle.raw.base64)) throw new Error("invalid base64 characters or padding");
    bytes = decodeBase64(bundle.raw.base64);
    if (encodeBase64(bytes) !== bundle.raw.base64) throw new Error("non-canonical base64");
  } catch {
    add("raw", false, "raw.base64 must contain canonical standard base64");
    return checks;
  }
  const hash = sha256(bytes);
  add("rawSha256", hash === observation.rawSha256, `SHA-256 of raw bytes = ${hash}`);
  add("byteLength", bytes.length === bundle.raw.byteLength, `decoded ${bytes.length} bytes; declared ${bundle.raw.byteLength}`);

  const raw: RawEvidence = {
    bytes,
    contentType: bundle.raw.contentType,
    httpStatus: bundle.raw.httpStatus,
    lastModified: bundle.raw.lastModified,
    sourceURL: observation.sourceURL,
    fetchedAt: observation.fetchedAt,
  };
  let parsed: WeatherObservation | undefined;
  try {
    parsed = observation.mode === "LIVE_HKO"
      ? parseDailyExtractObservation(raw, observation.targetDate, observation.metric)
      : parseDemoObservation(raw, observation.targetDate, observation.metric);
    const different = OBSERVATION_FIELDS.filter((key) => parsed![key] !== observation[key]);
    add("reparse", different.length === 0, different.length === 0
      ? `raw bytes reproduce ${parsed.metric} ${parsed.valueText} for ${parsed.targetDate}`
      : `raw bytes do not reproduce: ${different.join(", ")}`);
  } catch (error) {
    add("reparse", false, error instanceof Error ? error.message : "failed to re-parse raw bytes");
  }

  const capturedMs = captureTimeMs(observation.fetchedAt);
  add("fetchedAt", capturedMs !== null, "fetchedAt must be a valid ISO date-time with seconds and an explicit Z or UTC offset");
  if (observation.mode === "LIVE_HKO") {
    add("httpStatus", bundle.raw.httpStatus === 200, "LIVE evidence requires a captured HTTP 200 response");
    try {
      const url = dailyExtractMonthUrl(observation.targetDate);
      add("sourceUrl", observation.sourceURL === url, `LIVE evidence must cite ${url}`);
    } catch {
      add("sourceUrl", false, "cannot derive an official monthly URL for targetDate");
    }
    // Compare with the window derived here. Never use the window in the bundle.
    const windowEndMs = parsed ? Number(parsed.windowEnd) * 1000 : Number.NaN;
    add("completeDay", capturedMs !== null && Number.isFinite(windowEndMs) && capturedMs >= windowEndMs,
      "LIVE capture must be at or after the end of the requested Hong Kong calendar day");
  } else {
    add("fixtureSize", bytes.length <= MAX_EXCERPT_BYTES, `synthetic fixture is ${bytes.length} bytes (maximum ${MAX_EXCERPT_BYTES})`);
  }
  add("sourceUrlSize", utf8Length(observation.sourceURL) <= MAX_SOURCE_URL_BYTES, `source URL maximum is ${MAX_SOURCE_URL_BYTES} UTF-8 bytes`);
  add("excerptSize", utf8Length(observation.excerpt) <= MAX_EXCERPT_BYTES, `excerpt maximum is ${MAX_EXCERPT_BYTES} UTF-8 bytes`);
  if (expected) {
    const different = RULE_FIELDS.filter((key) => observation[key] !== expected[key]);
    add("rules", different.length === 0, different.length === 0
      ? "observation matches the expected metric, source, date and window"
      : `observation differs from expected rules: ${different.join(", ")}`);
  }
  return checks;
}

export function assertObservationBundle(value: unknown, expected?: ObservationEvidenceRules): ObservationBundle {
  const failed = checkObservationBundle(value, expected).filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new WeatherDataError("EVIDENCE_MISMATCH", failed.map((check) => `${check.name}: ${check.detail}`).join("; "));
  }
  return value as ObservationBundle;
}
