import { fetchRaw, type FetchPolicy } from "./fetch.js";
import { parseDailyExtractObservation, type WeatherMetric, type WeatherObservation } from "./observations.js";
import { dailyExtractMonthUrl, toCompactDate } from "./profile.js";
import { WeatherDataError } from "./strict.js";
import type { RawEvidence } from "./parse.js";

export const DAILY_METRICS: readonly WeatherMetric[] = ["TOTAL_RAINFALL_MM", "DAILY_MAX_TEMPERATURE_C"];

/** One raw snapshot supplies all requested metrics. Thresholds belong to the pool. */
export async function fetchDailyObservations(
  date: string,
  metrics: readonly WeatherMetric[] = DAILY_METRICS,
  policy: Partial<FetchPolicy> = {},
): Promise<{ raw: RawEvidence; observations: WeatherObservation[] }> {
  if (metrics.length === 0 || new Set(metrics).size !== metrics.length || metrics.some((m) => !DAILY_METRICS.includes(m))) {
    throw new WeatherDataError("DATA_INVALID", "select distinct supported daily weather metrics");
  }
  const compact = toCompactDate(date);
  const raw = await fetchRaw(dailyExtractMonthUrl(compact), policy);
  return { raw, observations: metrics.map((metric) => parseDailyExtractObservation(raw, compact, metric)) };
}
