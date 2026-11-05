import { DEFAULT_FETCH_POLICY, type FetchPolicy } from "./fetch.js";
import { fetchDailyObservations } from "./observation-fetch.js";
import { assertObservationBundle, buildObservationBundle } from "./observation-evidence.js";
import { hkDayWindow, toCompactDate } from "./profile.js";
import type { WeatherMetric } from "./observations.js";
import { WeatherDataError } from "./strict.js";

export type WeatherSelection = "rainfall" | "max-temperature" | "both";

export async function collectWeatherEvidence(date: string, selection: WeatherSelection = "both", policy: Partial<FetchPolicy> = {}) {
  const compact = toCompactDate(date);
  if (selection !== "rainfall" && selection !== "max-temperature" && selection !== "both") {
    throw new WeatherDataError("DATA_INVALID", "metric must be rainfall, max-temperature or both");
  }
  const now = (policy.now ?? DEFAULT_FETCH_POLICY.now)();
  if (!Number.isFinite(now.getTime())) throw new WeatherDataError("DATA_INVALID", "invalid collection clock");
  const { end } = hkDayWindow(compact);
  if (now.getTime() < Number(end) * 1000) {
    throw new WeatherDataError("DATA_UNAVAILABLE", "The selected Hong Kong day has not ended. Wait for the full day and published daily statistics.");
  }
  const metrics: WeatherMetric[] = selection === "both"
    ? ["TOTAL_RAINFALL_MM", "DAILY_MAX_TEMPERATURE_C"]
    : [selection === "rainfall" ? "TOTAL_RAINFALL_MM" : "DAILY_MAX_TEMPERATURE_C"];
  const { raw, observations } = await fetchDailyObservations(compact, metrics, policy);
  const bundles = observations.map(observation => assertObservationBundle(buildObservationBundle(raw, observation)));
  return { date: compact, raw, bundles };
}
