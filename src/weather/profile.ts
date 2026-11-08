export type WeatherObservationMode = "LIVE_HKO" | "DEMO_FIXTURE";

export const HKO_DAILY_EXTRACT_PROFILE = {
  sourceId: "HKO_DAILY_EXTRACT",
  stationId: "HKO",
  column: { index: 8, header: "Total Rainfall (mm)", group: "Hong Kong Observatory" },
  monthlyFile: "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_{YYYYMM}.xml",
  yearlyFile: "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_{YYYY}.xml",
  utcOffsetMinutes: 480,
} as const;

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;

export function parseCompactDate(compact: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(compact);
  if (!m) throw new RangeError(`date must be YYYYMMDD, got "${compact}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`not a calendar date: "${compact}"`);
  }
  return { year, month, day };
}

export function compactToIsoDate(compact: string): string {
  parseCompactDate(compact);
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

export function toCompactDate(input: string): string {
  const compact = input.replaceAll("-", "");
  parseCompactDate(compact);
  return compact;
}

export function hkDayWindow(compact: string): { start: bigint; end: bigint } {
  const { year, month, day } = parseCompactDate(compact);
  const startMs = Date.UTC(year, month - 1, day) - HKO_DAILY_EXTRACT_PROFILE.utcOffsetMinutes * 60_000;
  const start = BigInt(startMs / 1000);
  return { start, end: start + 86_400n };
}

export function dailyExtractMonthUrl(compactDate: string): string {
  parseCompactDate(compactDate);
  return HKO_DAILY_EXTRACT_PROFILE.monthlyFile.replace("{YYYYMM}", compactDate.slice(0, 6));
}

export function dailyExtractYearUrl(year: number): string {
  if (!Number.isInteger(year) || year < 1884 || year > 9999) throw new RangeError(`bad year ${year}`);
  return HKO_DAILY_EXTRACT_PROFILE.yearlyFile.replace("{YYYY}", String(year));
}

export const HKO_OPEN_DATA_ORIGIN = "https://data.weather.gov.hk";

export function ryesUrl(compactDate: string, lang: "en" | "sc" = "en"): string {
  parseCompactDate(compactDate);
  return `${HKO_OPEN_DATA_ORIGIN}/weatherAPI/opendata/opendata.php?dataType=RYES&date=${compactDate}&lang=${lang}&station=HKO`;
}

// V2 readings only state a fact. The contract applies the thresholds.
export const OBSERVATION_PARSER_VERSION = "rainpool-weather-parser/2.0.0";

export const HKO_WEATHER_METRICS = {
  TOTAL_RAINFALL_MM: {
    unit: "mm",
    scale: 100,
    column: { index: 8, header: "Total Rainfall (mm)", group: "Hong Kong Observatory" },
  },
  DAILY_MAX_TEMPERATURE_C: {
    unit: "degC",
    scale: 100,
    column: { index: 2, header: "Absolute Daily Max (deg. C)", group: "Hong Kong Observatory" },
  },
} as const;

export type WeatherMetric = keyof typeof HKO_WEATHER_METRICS;

export const DEMO_OBSERVATION_PROFILE = {
  sourceId: "DEMO_FIXTURE",
  stationId: "DEMO",
  fixtureKind: "RAINPOOL_DEMO_WEATHER_OBSERVATION_V2",
  notice: "Synthetic demo fixture. This file is not an actual weather observation.",
} as const;
