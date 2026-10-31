import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  currentWeatherPageUrl,
  currentWeatherUrl,
  hkDateOf,
  hkoTime,
  hourlyRainfallUrl,
  parseCurrentWeather,
  parseDailyRainfall,
  parseHourlyRainfall,
  previousHkDate,
  ryesRainfallToken,
} from "../../src/weather/live.js";
import { ryesUrl } from "../../src/weather/profile.js";
import { WeatherDataError } from "../../src/weather/strict.js";

const DIR = "fixtures/official/hko-open-data";
const LANGS = ["sc", "en"] as const;
type Doc = Record<string, unknown>;

function capture(feed: string, lang: string): { doc: Doc; meta: Record<string, unknown>; bytes: Buffer } {
  const file = readdirSync(DIR).find((f) => f.startsWith(`${feed}_${lang}_`) && !f.endsWith(".meta.json"));
  if (!file) throw new Error(`no ${feed} ${lang} capture in ${DIR}`);
  const bytes = readFileSync(path.join(DIR, file));
  const meta = JSON.parse(readFileSync(path.join(DIR, file.replace(/\.json$/, ".meta.json")), "utf8")) as Record<string, unknown>;
  return { doc: JSON.parse(bytes.toString("utf8")) as Doc, meta, bytes };
}
const at = (iso: string) => Date.parse(iso) / 1000;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof WeatherDataError ? err.code : (err as Error).name;
  }
  return "no error";
};

describe("live HKO panel: real captures", () => {
  it("each capture is the exact bytes of its recorded official URL", () => {
    const urls: Record<string, (lang: "sc" | "en") => string> = { rhrread: currentWeatherUrl, hourlyRainfall: hourlyRainfallUrl, "RYES-20261003": (lang) => ryesUrl("20261003", lang) };
    for (const lang of LANGS) {
      for (const [feed, url] of Object.entries(urls)) {
        const { meta, bytes } = capture(feed, lang);
        expect(meta.requestUrl).toBe(url(lang));
        expect(meta.sha256).toBe(`0x${createHash("sha256").update(bytes).digest("hex")}`);
        expect(meta.httpStatus).toBe(200);
      }
    }
  });

  it("current weather report: the Observatory's temperature and humidity with HKO's record and update times", () => {
    for (const lang of LANGS) {
      expect(parseCurrentWeather(capture("rhrread", lang).doc)).toEqual({
        updatedAt: at("2026-10-04T08:02:00+08:00"),
        temperature: { value: 27, unit: "C", at: at("2026-10-04T08:00:00+08:00") },
        humidity: { value: 91, unit: "percent", at: at("2026-10-04T08:00:00+08:00") },
        warnings: [],
      });
    }
  });

  it("past-hour rainfall: the Observatory station, not another station or a district maximum", () => {
    for (const lang of LANGS) {
      const { doc } = capture("hourlyRainfall", lang);
      expect(parseHourlyRainfall(doc)).toEqual({ until: at("2026-10-04T08:00:00+08:00"), mm: 0 });
      expect((doc.hourlyRainfall as Doc[]).some((r) => r.value === "M")).toBe(true);
    }
  });

  it("yesterday: RYES for 2026-10-03 gives the Observatory's 44.1 mm", () => {
    for (const lang of LANGS) {
      expect(parseDailyRainfall(capture("RYES-20261003", lang).doc, "20261003")).toEqual({ date: "20261003", rainfall: { kind: "NUMERIC", mm100: 4410, text: "44.1" } });
    }
  });
});

describe("live HKO panel: absent, maintenance and malformed values", () => {
  const rhr = () => structuredClone(capture("rhrread", "en").doc);
  const hourly = () => structuredClone(capture("hourlyRainfall", "en").doc);

  it("a block or Observatory row HKO left out is null, never a number", () => {
    const noTemperature = { ...rhr(), temperature: undefined };
    expect(parseCurrentWeather(noTemperature).temperature).toBeNull();
    expect(parseCurrentWeather({ ...rhr(), humidity: "" }).humidity).toBeNull();
    const otherPlaces = rhr();
    (otherPlaces.temperature as { data: Doc[] }).data = (otherPlaces.temperature as { data: Doc[] }).data.filter((r) => r.place !== "Hong Kong Observatory");
    expect(parseCurrentWeather(otherPlaces).temperature).toBeNull();
    const noStation = hourly();
    noStation.hourlyRainfall = (noStation.hourlyRainfall as Doc[]).filter((r) => r.automaticWeatherStation !== "Hong Kong Observatory");
    expect(parseHourlyRainfall(noStation)).toBeNull();
  });

  it("keeps warnings as published, drops blank entries and refuses anything else", () => {
    expect(parseCurrentWeather({ ...rhr(), warningMessage: ["Amber Rainstorm Warning Signal is in force.", " "] }).warnings).toEqual(["Amber Rainstorm Warning Signal is in force."]);
    expect(code(() => parseCurrentWeather({ ...rhr(), warningMessage: 3 }))).toBe("DATA_INVALID");
  });

  it("times need a UTC offset and a real date", () => {
    expect(hkoTime("2026-10-04T08:02:00+08:00", "t")).toBe(at("2026-10-04T00:02:00Z"));
    expect(code(() => hkoTime("2026-10-04T08:02:00", "t"))).toBe("DATA_INVALID");
    expect(code(() => hkoTime("2026-13-40T08:02:00+08:00", "t"))).toBe("DATA_INVALID");
    expect(code(() => parseCurrentWeather({ ...rhr(), updateTime: undefined }))).toBe("DATA_INVALID");
  });

  it("malformed readings are errors, not substitutes", () => {
    const text = rhr();
    (text.temperature as { data: Doc[] }).data.forEach((r) => (r.value = "27"));
    expect(code(() => parseCurrentWeather(text))).toBe("DATA_INVALID");
    const noUnit = rhr();
    (noUnit.humidity as { data: Doc[] }).data.forEach((r) => (r.unit = ""));
    expect(code(() => parseCurrentWeather(noUnit))).toBe("DATA_INVALID");
    expect(code(() => parseCurrentWeather({ ...rhr(), temperature: { recordTime: "2026-10-04T08:00:00+08:00", data: "x" } }))).toBe("DATA_INVALID");
    expect(code(() => parseCurrentWeather([]))).toBe("DATA_INVALID");
    expect(code(() => parseHourlyRainfall({ ...hourly(), hourlyRainfall: {} }))).toBe("DATA_INVALID");
  });

  it("reads the past hour's M as maintenance and refuses decimals, negatives and other units", () => {
    const withValue = (value: unknown, unit: unknown = "mm") => {
      const doc = hourly();
      for (const r of doc.hourlyRainfall as Doc[]) if (r.automaticWeatherStation === "Hong Kong Observatory") Object.assign(r, { value, unit });
      return doc;
    };
    expect(parseHourlyRainfall(withValue("M"))?.mm).toBeNull();
    expect(parseHourlyRainfall(withValue("12"))?.mm).toBe(12);
    for (const bad of ["1.5", "-1", "", "01", 3]) expect(code(() => parseHourlyRainfall(withValue(bad))), String(bad)).toBe("DATA_INVALID");
    expect(code(() => parseHourlyRainfall(withValue("3", "cm")))).toBe("DATA_INVALID");
  });

  it("reads another day's RYES report as not yet published and gives Trace and whole numbers the Daily Extract form", () => {
    const ryes = capture("RYES-20261003", "en").doc;
    expect(code(() => parseDailyRainfall(ryes, "20261004"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => parseDailyRainfall({ ...ryes, HKOReadingsRainfall: "" }, "20261003"))).toBe("DATA_UNAVAILABLE");
    expect(parseDailyRainfall({ ...ryes, HKOReadingsRainfall: "trace" }, "20261003").rainfall).toEqual({ kind: "TRACE", mm100: 0, text: "Trace" });
    expect(ryesRainfallToken(" 12 ")).toBe("12.0");
    expect(ryesRainfallToken("0.4")).toBe("0.4");
    expect(code(() => parseDailyRainfall({ ...ryes, HKOReadingsRainfall: "4.41" }, "20261003"))).toBe("DATA_INVALID");
    expect(() => parseDailyRainfall(ryes, "2026-10-03")).toThrow(RangeError);
  });
});

describe("live HKO panel: dates and URLs", () => {
  it("yesterday is the previous Hong Kong date, switching at Hong Kong midnight (UTC+8)", () => {
    expect(hkDateOf(at("2026-10-03T16:00:00Z"))).toBe("20261004");
    expect(hkDateOf(at("2026-10-03T15:59:59Z"))).toBe("20261003");
    expect(previousHkDate(at("2026-10-03T16:00:00Z"))).toBe("20261003");
    expect(previousHkDate(at("2026-03-01T00:00:00+08:00"))).toBe("20260228");
  });

  it("the panel reads the documented endpoints and links HKO's own page", () => {
    expect(currentWeatherUrl("sc")).toBe("https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=sc");
    expect(hourlyRainfallUrl("en")).toBe("https://data.weather.gov.hk/weatherAPI/opendata/hourlyRainfall.php?lang=en");
    expect(ryesUrl("20261003", "sc")).toBe("https://data.weather.gov.hk/weatherAPI/opendata/opendata.php?dataType=RYES&date=20261003&lang=sc&station=HKO");
    expect(ryesUrl("20261003")).toContain("&lang=en&");
    expect(currentWeatherPageUrl("sc")).toBe("https://www.hko.gov.hk/sc/wxinfo/currwx/current.htm");
  });
});
