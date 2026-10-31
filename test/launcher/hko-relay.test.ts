import { describe, expect, it, vi } from "vitest";
import { HKO_RELAY_PREFIX, hkoUpstreamUrl, relayHko } from "../../launcher/hko-relay.mjs";
import { currentWeatherUrl, hourlyRainfallUrl } from "../../src/weather/live.js";
import { dailyExtractMonthUrl, ryesUrl } from "../../src/weather/profile.js";

const viaRelay = (official: string) => {
  const u = new URL(official);
  return `${HKO_RELAY_PREFIX}${u.pathname}${u.search}`;
};
const OFFICIAL = [
  ...(["sc", "en"] as const).flatMap((lang) => [currentWeatherUrl(lang), hourlyRainfallUrl(lang), ryesUrl("20261003", lang)]),
  dailyExtractMonthUrl("20261105"),
];
const response = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("HKO relay allow-list", () => {
  it("allows exactly the official URLs the panel builds, unchanged", () => {
    for (const url of OFFICIAL) expect(hkoUpstreamUrl(viaRelay(url))).toBe(url);
  });

  it("refuses other datasets, stations, parameters, hosts and paths", () => {
    const refused = [
      "/hko-open-data/weatherAPI/opendata/weather.php?dataType=flw&lang=sc",
      "/hko-open-data/weatherAPI/opendata/weather.php?dataType=rhrread",
      "/hko-open-data/weatherAPI/opendata/weather.php?dataType=rhrread&lang=sc&extra=1",
      "/hko-open-data/weatherAPI/opendata/weather.php?dataType=rhrread&lang=sc&lang=en",
      "/hko-open-data/weatherAPI/opendata/weather.php?dataType=rhrread&lang=fr",
      "/hko-open-data/weatherAPI/opendata/opendata.php?dataType=RYES&date=2026103&lang=sc&station=HKO",
      "/hko-open-data/weatherAPI/opendata/opendata.php?dataType=RYES&date=20261003&lang=sc&station=CLK",
      "/hko-open-data/weatherAPI/opendata/hourlyRainfall.php?lang=%73c%26x=1",
      "/hko-open-data//evil.example/weatherAPI/opendata/hourlyRainfall.php?lang=sc",
      "/hko-open-data/weatherAPI/../../etc/passwd",
      "/hko-open-data/weatherAPI/opendata/hourlyRainfall.php?lang=sc#x",
      "/hko-open-dataX/weatherAPI/opendata/hourlyRainfall.php?lang=sc",
      "/weatherAPI/opendata/hourlyRainfall.php?lang=sc",
      "/hko-open-data/cis/dailyExtract/dailyExtract_2026.xml",
      "/hko-open-data/cis/dailyExtract/dailyExtract_202611.xml?x=1",
      "/hko-open-data/cis/dailyExtract/dailyExtract_202611.json",
      "/hko-open-data/cis/hko.xml",
    ];
    for (const path of refused) expect(hkoUpstreamUrl(path), path).toBeNull();
  });
});

describe("HKO relay responses", () => {
  it("returns HKO's bytes unchanged as JSON for an allowed read", async () => {
    const body = '{"obsTime":"2026-10-04T08:00:00+08:00","hourlyRainfall":[]}';
    const fetchImpl = vi.fn(async () => response(body));
    const r = await relayHko(viaRelay(hourlyRainfallUrl("sc")), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe(hourlyRainfallUrl("sc"));
    expect([r.status, r.type, Buffer.from(r.body).toString()]).toEqual([200, "application/json; charset=utf-8", body]);
  });

  it("passes the Daily Extract month file from the HKO site with its own content type", async () => {
    const body = '{"stn":{"data":[]}}';
    const fetchImpl = vi.fn(async () => response(body, { headers: { "content-type": "text/xml" } }));
    const r = await relayHko(viaRelay(dailyExtractMonthUrl("20261105")), fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202611.xml");
    expect([r.status, r.type, Buffer.from(r.body).toString()]).toEqual([200, "text/xml; charset=utf-8", body]);
  });

  it("answers 404 without any upstream call for a read that is not allowed", async () => {
    const fetchImpl = vi.fn(async () => response("{}"));
    expect((await relayHko("/hko-open-data/weatherAPI/opendata/weather.php?dataType=fnd&lang=sc", fetchImpl)).status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HKO errors, unreachable HKO and oversized answers as 502, never as data", async () => {
    const path = viaRelay(currentWeatherUrl("sc"));
    expect(await relayHko(path, async () => response("busy", { status: 503 }))).toMatchObject({ status: 502, body: "HKO answered HTTP 503\n" });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(await relayHko(path, async () => Promise.reject(reset))).toMatchObject({ status: 502, body: "HKO unreachable: ECONNRESET\n" });
    expect((await relayHko(path, async () => response("{}", { headers: { "content-length": String(10_000_000) } }))).status).toBe(502);
    expect((await relayHko(path, async () => response("x".repeat(300 * 1024)))).status).toBe(502);
  });
});
