import { sha256 } from "ethers";
import { fetchRaw, type FetchPolicy } from "./fetch.js";
import type { RawEvidence } from "./parse.js";
import { HKO_OPEN_DATA_ORIGIN } from "./profile.js";
import { decodeUtf8, parseJsonStrict, WeatherDataError } from "./strict.js";

export type WarningLanguage = "en" | "sc" | "tc";
export type TropicalCycloneSignalCode = "TC1" | "TC3" | "TC8NE" | "TC8SE" | "TC8NW" | "TC8SW" | "TC9" | "TC10" | "CANCEL";
export type TropicalCycloneLevel = 1 | 3 | 8 | 9 | 10;
export type TropicalCycloneDirection = "NE" | "SE" | "NW" | "SW";

export interface TropicalCycloneWarningSnapshot {
  schemaVersion: 1;
  sourceId: "HKO_WARNSUM";
  metric: "TROPICAL_CYCLONE_WARNING";
  scope: "CURRENT_SNAPSHOT";
  historicalCoverage: false;
  status: "ACTIVE" | "CANCELLED" | "NO_ACTIVE_WARNING";
  signalCode: TropicalCycloneSignalCode | null;
  level: TropicalCycloneLevel | null;
  direction: TropicalCycloneDirection | null;
  actionCode: "ISSUE" | "CANCEL" | null;
  name: string | null;
  issueTime: string | null;
  updateTime: string | null;
  expireTime: string | null;
  fetchedAt: string;
  lastModified: string | null;
  sourceURL: string;
  rawSha256: string;
  parserVersion: "rainpool-warning-parser/1.0.0";
}

const SIGNALS: Record<TropicalCycloneSignalCode, { level: TropicalCycloneLevel | null; direction: TropicalCycloneDirection | null }> = {
  TC1: { level: 1, direction: null },
  TC3: { level: 3, direction: null },
  TC8NE: { level: 8, direction: "NE" },
  TC8SE: { level: 8, direction: "SE" },
  TC8NW: { level: 8, direction: "NW" },
  TC8SW: { level: 8, direction: "SW" },
  TC9: { level: 9, direction: null },
  TC10: { level: 10, direction: null },
  CANCEL: { level: null, direction: null },
};
const OTHER_WARNING_CODES: Record<string, readonly string[]> = {
  WFIRE: ["WFIREY", "WFIRER"],
  WFROST: ["WFROST"],
  WHOT: ["WHOT"],
  WCOLD: ["WCOLD"],
  WMSGNL: ["WMSGNL"],
  WRAIN: ["WRAINA", "WRAINR", "WRAINB"],
  WFNTSA: ["WFNTSA"],
  WL: ["WL"],
  WTMW: ["WTMW"],
  WTS: ["WTS"],
};
const ACTIONS = new Set(["ISSUE", "REISSUE", "CANCEL", "EXTEND", "UPDATE"]);
const FUTURE_CLOCK_TOLERANCE_MS = 5 * 60_000;

export function warningSummaryUrl(lang: WarningLanguage = "en"): string {
  if (!["en", "sc", "tc"].includes(lang)) throw new RangeError("unsupported HKO warning language");
  return HKO_OPEN_DATA_ORIGIN + "/weatherAPI/opendata/weather.php?dataType=warnsum&lang=" + lang;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown, field: string): { text: string; ms: number } {
  if (typeof value !== "string") throw new WeatherDataError("DATA_INVALID", field + " must be an ISO timestamp");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new WeatherDataError("DATA_INVALID", field + " must include a timezone");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const ms = Date.parse(value);
  if (year < 1000 || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 ||
      offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0) || !Number.isFinite(ms)) {
    throw new WeatherDataError("DATA_INVALID", field + " is not a valid calendar timestamp");
  }
  return { text: value, ms };
}

/**
 * Parses the official warnsum snapshot. It is not a warning archive.
 * NO_ACTIVE_WARNING only means this response has no WTCSGNL entry.
 * A stored snapshot proves nothing about later conditions or a whole month.
 * Source: HKO Open Data API Documentation, Weather Warning Summary.
 */
export function parseTropicalCycloneWarning(raw: RawEvidence): TropicalCycloneWarningSnapshot {
  if (!["en", "sc", "tc"].some((lang) => raw.sourceURL === warningSummaryUrl(lang as WarningLanguage))) {
    throw new WeatherDataError("EVIDENCE_MISMATCH", "warning source must be the official HKO warnsum URL");
  }
  if (raw.httpStatus !== 200) throw new WeatherDataError("DATA_UNAVAILABLE", "warning snapshot requires HTTP 200");
  const fetched = timestamp(raw.fetchedAt, "fetchedAt");
  const text = decodeUtf8(raw.bytes);
  if ((raw.contentType ?? "").toLowerCase().includes("text/html") || /^\s*</.test(text)) {
    throw new WeatherDataError("DATA_UNAVAILABLE", "HKO returned HTML instead of warning JSON");
  }
  const doc = parseJsonStrict(text);
  if (!isObject(doc)) throw new WeatherDataError("DATA_INVALID", "warnsum must be a JSON object");
  for (const [key, value] of Object.entries(doc)) {
    if (key !== "WTCSGNL" && !Object.hasOwn(OTHER_WARNING_CODES, key)) {
      throw new WeatherDataError("DATA_INVALID", "unrecognized warnsum entry " + key);
    }
    if (!isObject(value) || typeof value.name !== "string" || value.name.trim() === "" ||
        typeof value.code !== "string" || typeof value.actionCode !== "string" || !ACTIONS.has(value.actionCode)) {
      throw new WeatherDataError("DATA_INVALID", "invalid warning entry " + key);
    }
    if (key !== "WTCSGNL" && !OTHER_WARNING_CODES[key]!.includes(value.code)) {
      throw new WeatherDataError("DATA_INVALID", "unrecognized code for " + key);
    }
    timestamp(value.issueTime, key + ".issueTime");
    timestamp(value.updateTime, key + ".updateTime");
  }
  const base: TropicalCycloneWarningSnapshot = {
    schemaVersion: 1,
    sourceId: "HKO_WARNSUM",
    metric: "TROPICAL_CYCLONE_WARNING",
    scope: "CURRENT_SNAPSHOT",
    historicalCoverage: false,
    status: "NO_ACTIVE_WARNING",
    signalCode: null,
    level: null,
    direction: null,
    actionCode: null,
    name: null,
    issueTime: null,
    updateTime: null,
    expireTime: null,
    fetchedAt: fetched.text,
    lastModified: raw.lastModified,
    sourceURL: raw.sourceURL,
    rawSha256: sha256(raw.bytes),
    parserVersion: "rainpool-warning-parser/1.0.0",
  };
  if (!Object.hasOwn(doc, "WTCSGNL")) return base;
  const warning = doc.WTCSGNL as Record<string, unknown>;
  const code = warning.code as string;
  if (!Object.hasOwn(SIGNALS, code)) throw new WeatherDataError("DATA_INVALID", "unrecognized tropical cyclone code " + code);
  if (warning.actionCode !== "ISSUE" && warning.actionCode !== "CANCEL") {
    throw new WeatherDataError("DATA_INVALID", "unexpected tropical cyclone actionCode");
  }
  if (code === "CANCEL" && warning.actionCode !== "CANCEL") {
    throw new WeatherDataError("DATA_INVALID", "CANCEL signal must have CANCEL action");
  }
  const issue = timestamp(warning.issueTime, "WTCSGNL.issueTime");
  const update = timestamp(warning.updateTime, "WTCSGNL.updateTime");
  const expiry = warning.expireTime === undefined || warning.expireTime === null
    ? null : timestamp(warning.expireTime, "WTCSGNL.expireTime");
  if (update.ms < issue.ms || update.ms > fetched.ms + FUTURE_CLOCK_TOLERANCE_MS ||
      (expiry !== null && expiry.ms < issue.ms)) {
    throw new WeatherDataError("DATA_INVALID", "inconsistent warning timestamps");
  }
  const cancelled = warning.actionCode === "CANCEL";
  if (!cancelled && expiry !== null && expiry.ms <= fetched.ms) {
    throw new WeatherDataError("DATA_UNAVAILABLE", "active warning has expired; fetch a new snapshot");
  }
  const signalCode = code as TropicalCycloneSignalCode;
  return {
    ...base,
    status: cancelled ? "CANCELLED" : "ACTIVE",
    signalCode,
    level: cancelled ? null : SIGNALS[signalCode].level,
    direction: cancelled ? null : SIGNALS[signalCode].direction,
    actionCode: warning.actionCode,
    name: warning.name as string,
    issueTime: issue.text,
    updateTime: update.text,
    expireTime: expiry?.text ?? null,
  };
}

export async function fetchTropicalCycloneWarning(
  lang: WarningLanguage = "en",
  policy: Partial<FetchPolicy> = {},
): Promise<{ raw: RawEvidence; snapshot: TropicalCycloneWarningSnapshot }> {
  const raw = await fetchRaw(warningSummaryUrl(lang), policy);
  return { raw, snapshot: parseTropicalCycloneWarning(raw) };
}
