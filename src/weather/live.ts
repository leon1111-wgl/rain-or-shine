import { HKO_DAILY_EXTRACT_PROFILE, HKO_OPEN_DATA_ORIGIN, parseCompactDate } from "./profile.js";
import { WeatherDataError, parseRainfallToken, type RainfallValue } from "./strict.js";

export type HkoLang = "sc" | "en";

const HEADQUARTERS: ReadonlySet<string> = new Set(["Hong Kong Observatory", "香港天文台"]);

export const currentWeatherUrl = (lang: HkoLang) => `${HKO_OPEN_DATA_ORIGIN}/weatherAPI/opendata/weather.php?dataType=rhrread&lang=${lang}`;
export const hourlyRainfallUrl = (lang: HkoLang) => `${HKO_OPEN_DATA_ORIGIN}/weatherAPI/opendata/hourlyRainfall.php?lang=${lang}`;
export const currentWeatherPageUrl = (lang: HkoLang) => `https://www.hko.gov.hk/${lang}/wxinfo/currwx/current.htm`;

export interface Reading {
  value: number;
  unit: string;
  at: number;
}

export interface CurrentWeather {
  updatedAt: number;
  temperature: Reading | null;
  humidity: Reading | null;
  warnings: string[];
}

export interface HourlyRain {
  until: number;
  mm: number | null;
}

export interface DailyRain {
  date: string;
  rainfall: RainfallValue;
}

const invalid = (message: string) => new WeatherDataError("DATA_INVALID", message);

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${field} is not an object`);
  return value as Record<string, unknown>;
}

const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

export function hkoTime(value: unknown, field: string): number {
  if (typeof value !== "string" || !OFFSET_TIME.test(value)) throw invalid(`${field} is not a time with a UTC offset`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid(`${field} "${value}" is not a valid time`);
  return Math.floor(ms / 1000);
}

function atHeadquarters(block: unknown, field: string): Reading | null {
  if (block === undefined || block === "") return null;
  const b = objectOf(block, field);
  const at = hkoTime(b.recordTime, `${field}.recordTime`);
  if (!Array.isArray(b.data)) throw invalid(`${field}.data is not a list`);
  const row = b.data.map((r, i) => objectOf(r, `${field}.data[${i}]`)).find((r) => typeof r.place === "string" && HEADQUARTERS.has(r.place));
  if (!row) return null;
  if (typeof row.value !== "number" || !Number.isFinite(row.value)) throw invalid(`${field} at the Observatory is not a number`);
  if (typeof row.unit !== "string" || row.unit === "") throw invalid(`${field} at the Observatory has no unit`);
  return { value: row.value, unit: row.unit, at };
}

export function parseCurrentWeather(doc: unknown): CurrentWeather {
  const d = objectOf(doc, "current weather report");
  const w = d.warningMessage;
  const warnings = w === undefined || w === "" ? [] : Array.isArray(w) && w.every((m) => typeof m === "string") ? w.filter((m) => m.trim() !== "") : null;
  if (warnings === null) throw invalid("warningMessage is neither a list of text nor empty");
  return {
    updatedAt: hkoTime(d.updateTime, "updateTime"),
    temperature: atHeadquarters(d.temperature, "temperature"),
    humidity: atHeadquarters(d.humidity, "humidity"),
    warnings,
  };
}

export function parseHourlyRainfall(doc: unknown): HourlyRain | null {
  const d = objectOf(doc, "past-hour rainfall");
  const until = hkoTime(d.obsTime, "obsTime");
  if (!Array.isArray(d.hourlyRainfall)) throw invalid("hourlyRainfall is not a list");
  const row = d.hourlyRainfall
    .map((r, i) => objectOf(r, `hourlyRainfall[${i}]`))
    .find((r) => typeof r.automaticWeatherStation === "string" && HEADQUARTERS.has(r.automaticWeatherStation));
  if (!row) return null;
  if (row.value === "M") return { until, mm: null };
  if (row.unit !== "mm") throw invalid(`past-hour rainfall unit is "${String(row.unit)}", expected mm`);
  if (typeof row.value !== "string" || !/^(0|[1-9]\d{0,3})$/.test(row.value)) throw invalid(`past-hour rainfall "${String(row.value)}" is not a whole number of mm`);
  return { until, mm: Number(row.value) };
}

export function ryesRainfallToken(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new WeatherDataError("DATA_UNAVAILABLE", "RYES HKOReadingsRainfall is missing");
  const text = value.trim();
  if (text.toLowerCase() === "trace") return "Trace";
  return /^\d+$/.test(text) ? `${text}.0` : text;
}

export function parseDailyRainfall(doc: unknown, compactDate: string): DailyRain {
  parseCompactDate(compactDate);
  const d = objectOf(doc, "RYES report");
  if (d.ReportTimeInfoDate !== compactDate) throw new WeatherDataError("DATA_UNAVAILABLE", `RYES has no report for ${compactDate} yet`);
  return { date: compactDate, rainfall: parseRainfallToken(ryesRainfallToken(d.HKOReadingsRainfall), "RYES HKOReadingsRainfall") };
}

export function hkDateOf(unixSeconds: number): string {
  const d = new Date((unixSeconds + HKO_DAILY_EXTRACT_PROFILE.utcOffsetMinutes * 60) * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export const previousHkDate = (unixSeconds: number) => hkDateOf(unixSeconds - 86_400);
