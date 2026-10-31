import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectWeatherEvidence, type WeatherSelection } from "../../src/weather/collect-evidence.js";
import { checkObservationBundle } from "../../src/weather/observation-evidence.js";
import { dailyExtractMonthUrl } from "../../src/weather/profile.js";

const fixtureDir = "fixtures/official/hko-daily-extract";
const fixture = readdirSync(fixtureDir).find(file => file.startsWith("dailyExtract_202609_") && file.endsWith(".raw"))!;
const bytes = readFileSync(join(fixtureDir, fixture));
const now = () => new Date("2026-10-21T12:00:00Z");
function policy() {
  return { now, retries: 0, fetchImpl: vi.fn<typeof fetch>(async () => new Response(bytes, { status: 200, headers: { "content-type": "text/xml" } })) };
}
describe("portable weather evidence collection", () => {
  it("builds two valid v3 bundles from exactly one official snapshot", async () => {
    const http = policy();
    const result = await collectWeatherEvidence("2026-09-14", "both", http);
    expect(http.fetchImpl).toHaveBeenCalledTimes(1);
    expect(http.fetchImpl.mock.calls[0]?.[0]).toBe(dailyExtractMonthUrl("20260914"));
    expect(result.bundles.map(bundle => bundle.observation.value)).toEqual([3790, 2870]);
    expect(result.bundles.map(bundle => bundle.observation.mode)).toEqual(["LIVE_HKO", "LIVE_HKO"]);
    expect(new Set(result.bundles.map(bundle => bundle.observation.rawSha256)).size).toBe(1);
    expect(result.bundles.every(bundle => checkObservationBundle(bundle).every(check => check.ok))).toBe(true);
    expect(result.bundles[0]?.observation).not.toHaveProperty("outcome");
  });
  it.each([["rainfall", "TOTAL_RAINFALL_MM"], ["max-temperature", "DAILY_MAX_TEMPERATURE_C"]] as const)("selects %s only", async (selection, metric) => {
    const result = await collectWeatherEvidence("20260914", selection, policy());
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.observation.metric).toBe(metric);
  });
  it.each(["20261021", "20261022"])("rejects an unfinished/future Hong Kong day %s before HTTP", async date => {
    const http = policy();
    await expect(collectWeatherEvidence(date, "both", http)).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(http.fetchImpl).not.toHaveBeenCalled();
  });
  it("uses Hong Kong midnight as the completion boundary", async () => {
    const http = policy();
    await expect(collectWeatherEvidence("20260914", "both", { ...http, now: () => new Date("2026-09-14T15:59:59Z") })).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    const result = await collectWeatherEvidence("20260914", "both", { ...http, now: () => new Date("2026-09-14T16:00:00Z") });
    expect(result.bundles).toHaveLength(2);
    expect(http.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid dates and unsupported metrics before HTTP", async () => {
    const http = policy();
    await expect(collectWeatherEvidence("20260931", "both", http)).rejects.toThrow();
    await expect(collectWeatherEvidence("20260914", "humidity" as WeatherSelection, http)).rejects.toMatchObject({ code: "DATA_INVALID" });
    expect(http.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not create evidence from a missing daily row or malformed response", async () => {
    await expect(collectWeatherEvidence("20261001", "both", policy())).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    await expect(collectWeatherEvidence("20260914", "both", { ...policy(), fetchImpl: async () => new Response("invalid official response") })).rejects.toMatchObject({ code: "DATA_INVALID" });
  });
});
