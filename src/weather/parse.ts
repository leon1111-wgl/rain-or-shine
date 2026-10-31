import { WeatherDataError, decodeUtf8, parseJsonStrict, parseRainfallToken } from "./strict.js";
import { compactToIsoDate, parseCompactDate, toCompactDate } from "./profile.js";

export interface RawEvidence {
  bytes: Uint8Array;
  contentType: string | null;
  httpStatus: number | null;
  fetchedAt: string | null;
  lastModified: string | null;
  sourceURL: string;
}

const SUMMARY_LABELS = new Set(["Mean/Total", "Normal"]);
const MONTHLY_RE = /^https:\/\/www\.hko\.gov\.hk\/cis\/dailyExtract\/dailyExtract_(\d{6})\.xml$/;
const YEARLY_RE = /^https:\/\/www\.hko\.gov\.hk\/cis\/dailyExtract\/dailyExtract_(\d{4})\.xml$/;

type FileKind = "MONTHLY" | "YEARLY";

function fileKindFor(url: string, compact: string): FileKind {
  const monthly = MONTHLY_RE.exec(url);
  if (monthly) {
    if (monthly[1] !== compact.slice(0, 6)) throw new WeatherDataError("EVIDENCE_MISMATCH", `${url} is not the monthly file for ${compactToIsoDate(compact)}`);
    return "MONTHLY";
  }
  const yearly = YEARLY_RE.exec(url);
  if (yearly) {
    if (yearly[1] !== compact.slice(0, 4)) throw new WeatherDataError("EVIDENCE_MISMATCH", `${url} is not the yearly file for ${compactToIsoDate(compact)}`);
    return "YEARLY";
  }
  throw new WeatherDataError("EVIDENCE_MISMATCH", `${url} is not an official HKO Daily Extract file URL`);
}

function looksLikeHtml(text: string, contentType: string | null): boolean {
  if ((contentType ?? "").toLowerCase().includes("text/html") || /^\s*</.test(text)) return true;
  return !text.trimStart().startsWith("{") && /<\/?[a-z][^>]*>/i.test(text);
}

interface MonthEntry {
  month: number;
  dayData: string[][];
}

function readMonths(doc: unknown, width: number): MonthEntry[] {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(doc) || !isObject(doc.stn) || !Array.isArray(doc.stn.data)) {
    throw new WeatherDataError("DATA_INVALID", 'expected {"stn":{"data":[...]}}; the Daily Extract format changed');
  }
  return doc.stn.data.map((entry, i) => {
    if (!isObject(entry) || !Number.isInteger(entry.month) || !Array.isArray(entry.dayData)) {
      throw new WeatherDataError("DATA_INVALID", `stn.data[${i}] is not {month, dayData}`);
    }
    const rows = entry.dayData.map((row, k) => {
      if (!Array.isArray(row) || row.length !== width || !row.every((cell) => typeof cell === "string")) {
        throw new WeatherDataError("DATA_INVALID", `month ${String(entry.month)} row ${k} is not ${width} strings`);
      }
      return row as string[];
    });
    return { month: entry.month as number, dayData: rows };
  });
}

function checkRows(rows: string[][], year: number, month: number): void {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row[0] ?? "";
    if (SUMMARY_LABELS.has(label)) continue;
    if (!/^\d{2}$/.test(label) || Number(label) < 1 || Number(label) > daysInMonth) {
      throw new WeatherDataError("DATA_INVALID", `unexpected row label "${label}" in ${year}-${String(month).padStart(2, "0")}`);
    }
    if (seen.has(label)) throw new WeatherDataError("DATA_INVALID", `day ${label} appears more than once in ${year}-${String(month).padStart(2, "0")}`);
    seen.add(label);
  }
}

export function checkDailyExtractRainfallTotal(rows: string[][], ym: string): void {
  const total = rows.find((r) => r[0] === "Mean/Total");
  if (!total) return;
  let sum = 0;
  for (const row of rows) {
    if (!/^\d{2}$/.test(row[0] ?? "")) continue;
    try {
      sum += parseRainfallToken(row[8], "day").mm100;
    } catch {
      return;
    }
  }
  const published = parseRainfallToken(total[8], `Total Rainfall (mm) Mean/Total ${ym}`);
  if (published.mm100 !== sum) {
    throw new WeatherDataError("DATA_INVALID", `${ym}: the days add up to ${sum / 100} mm but the file's Mean/Total says ${published.text} mm (inconsistent snapshot)`);
  }
}

export interface DailyExtractDay {
  compactDate: string;
  row: string[];
  rows: string[][];
}

/** Read an official day once. Metric-specific checks belong to the metric parser. */
export function readDailyExtractDay(raw: RawEvidence, requestedDate: string): DailyExtractDay {
  const compact = toCompactDate(requestedDate);
  const { year, month } = parseCompactDate(compact);
  const iso = compactToIsoDate(compact);
  const kind = fileKindFor(raw.sourceURL, compact);
  if (raw.httpStatus !== null && raw.httpStatus !== 200) {
    throw new WeatherDataError("DATA_UNAVAILABLE", `HTTP ${raw.httpStatus} from ${raw.sourceURL}`);
  }
  const text = decodeUtf8(raw.bytes);
  if (looksLikeHtml(text, raw.contentType)) {
    throw new WeatherDataError("DATA_UNAVAILABLE", "HKO returned an HTML page instead of the JSON data file");
  }
  const months = readMonths(parseJsonStrict(text), kind === "MONTHLY" ? 9 : 12).filter((m) => m.month === month);
  if (months.length === 0) throw new WeatherDataError("DATA_UNAVAILABLE", `${raw.sourceURL} has no month ${month}`);
  if (months.length > 1) throw new WeatherDataError("DATA_INVALID", `month ${month} appears ${months.length} times`);
  const rows = months[0]?.dayData ?? [];
  checkRows(rows, year, month);
  const row = rows.find((r) => r[0] === compact.slice(6, 8));
  if (!row) throw new WeatherDataError("DATA_UNAVAILABLE", `no row for ${iso} yet (the day is not published in this file)`);
  return { compactDate: compact, row, rows };
}
