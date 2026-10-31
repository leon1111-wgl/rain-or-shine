import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchDailyObservations } from "../../src/weather/observation-fetch.js";
import { dailyExtractMonthUrl } from "../../src/weather/profile.js";

const dir = "fixtures/official/hko-daily-extract";
const file = readdirSync(dir).find((f) => f.startsWith("dailyExtract_202609_") && f.endsWith(".raw"))!;
const bytes = readFileSync(path.join(dir, file));

describe("generic daily fetching", () => {
  it("gets both metrics from exactly one official monthly snapshot", async () => {
    const calls: string[] = [];
    const { raw, observations } = await fetchDailyObservations("2026-09-14", undefined, {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(bytes, { status: 200, headers: { "content-type": "text/xml" } });
      },
      now: () => new Date("2026-10-02T09:00:00Z"),
    });
    expect(calls).toEqual([dailyExtractMonthUrl("20260914")]);
    expect(raw.bytes).toEqual(new Uint8Array(bytes));
    expect(observations.map((o) => [o.metric, o.value, o.unit])).toEqual([
      ["TOTAL_RAINFALL_MM", 3790, "mm"], ["DAILY_MAX_TEMPERATURE_C", 2870, "degC"],
    ]);
    expect(observations[0]?.rawSha256).toBe(observations[1]?.rawSha256);
    expect(observations[0]?.excerpt).toBe(observations[1]?.excerpt);
    expect(observations[0]).not.toHaveProperty("outcomeAtThreshold");
  });
  it("selects temperature only and rejects empty or duplicated selectors before fetching", async () => {
    let calls = 0;
    const policy = { fetchImpl: (async () => { calls++; return new Response(bytes); }) as typeof fetch };
    expect((await fetchDailyObservations("20260914", ["DAILY_MAX_TEMPERATURE_C"], policy)).observations).toHaveLength(1);
    await expect(fetchDailyObservations("20260914", [], policy)).rejects.toMatchObject({ code: "DATA_INVALID" });
    await expect(fetchDailyObservations("20260914", ["TOTAL_RAINFALL_MM", "TOTAL_RAINFALL_MM"], policy)).rejects.toMatchObject({ code: "DATA_INVALID" });
    expect(calls).toBe(1);
  });
});
