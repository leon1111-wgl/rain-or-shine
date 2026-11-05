import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import { demoObservationText, parseDailyExtractObservation, parseDemoObservation, type WeatherMetric } from "../../src/weather/observations.js";
import type { RawEvidence } from "../../src/weather/parse.js";
import { OBSERVATION_PARSER_VERSION, dailyExtractMonthUrl, dailyExtractYearUrl } from "../../src/weather/profile.js";
import { WeatherDataError, parseOneDecimalToken, parseTemperatureToken } from "../../src/weather/strict.js";

const DIR = "fixtures/official/hko-daily-extract";
const RAIN = "TOTAL_RAINFALL_MM";
const TEMP = "DAILY_MAX_TEMPERATURE_C";

function capture(file: string): RawEvidence {
  const metaName = readdirSync(DIR).find((name) => name.startsWith(`dailyExtract_${file}_`) && name.endsWith(".meta.json"));
  if (!metaName) throw new Error(`no capture for ${file}`);
  const meta = JSON.parse(readFileSync(path.join(DIR, metaName), "utf8")) as {
    requestUrl: string; fetchedAt: string; httpStatus: number; contentType: string; lastModified: string | null;
  };
  const bytes = new Uint8Array(readFileSync(path.join(DIR, metaName.replace(".meta.json", ".raw"))));
  return { bytes, sourceURL: meta.requestUrl, fetchedAt: meta.fetchedAt, httpStatus: meta.httpStatus, contentType: meta.contentType, lastModified: meta.lastModified };
}

const SEP = capture("202609");
const OCT = capture("202610");
const synthetic = (text: string, extra: Partial<RawEvidence> = {}): RawEvidence => ({ ...SEP, ...extra, bytes: new TextEncoder().encode(text) });
const editSep = (edit: (text: string) => string): RawEvidence => synthetic(edit(new TextDecoder().decode(SEP.bytes)));
const demo = (text: string): RawEvidence => synthetic(text, { sourceURL: "fixture:weather-v2.json", httpStatus: null, lastModified: null });

function code(fn: () => unknown): string {
  try { fn(); } catch (err) {
    if (err instanceof WeatherDataError) return err.code;
    throw err;
  }
  return "OK";
}

describe("V2 observations from preserved official HKO data", () => {
  it("selects daily maximum temperature, not the mean/minimum, and retains provenance", () => {
    const result = parseDailyExtractObservation(SEP, "2026-09-14", TEMP);
    expect(result).toMatchObject({ schemaVersion: 2, mode: "LIVE_HKO", sourceId: "HKO_DAILY_EXTRACT", stationId: "HKO", targetDate: "20260914", metric: TEMP, unit: "degC", scale: 100, kind: "NUMERIC", value: 2870, valueText: "28.7", parserVersion: OBSERVATION_PARSER_VERSION });
    expect(result.sourceURL).toBe(dailyExtractMonthUrl("20260914"));
    expect(result.rawSha256).toBe(sha256(SEP.bytes));
    expect(result.excerpt).toBe('["14","1014.1","28.7","27.8","26.1","24.8","84","88"," 37.9"]');
    expect(result.fetchedAt).toBe(SEP.fetchedAt);
    expect(result.lastModified).toBe(SEP.lastModified);
    expect([result.windowStart, result.windowEnd]).toEqual([String(Date.UTC(2026, 8, 13, 16) / 1000), String(Date.UTC(2026, 8, 14, 16) / 1000)]);
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("threshold");
  });

  it("supports monthly and yearly files across the year boundary", () => {
    expect(parseDailyExtractObservation(OCT, "20261001", TEMP).value).toBe(3360);
    const december = parseDailyExtractObservation(capture("2025"), "20251231", TEMP);
    expect(december.value).toBe(2080);
    expect(december.sourceURL).toBe(dailyExtractYearUrl(2025));
    expect(parseDailyExtractObservation(capture("2026"), "20260101", TEMP).value).toBe(2170);
  });

  it("reads rainfall independently and preserves Trace as an unknown exact value", () => {
    const result = parseDailyExtractObservation(SEP, "20260914", RAIN);
    expect(result).toMatchObject({ metric: RAIN, unit: "mm", scale: 100, kind: "NUMERIC", value: 3790, valueText: "37.9" });
    expect(parseDailyExtractObservation(SEP, "20260903", RAIN).value).toBe(0);
    expect(parseDailyExtractObservation(SEP, "20260913", RAIN)).toMatchObject({ kind: "TRACE", value: null, valueText: "Trace" });
  });
});

describe("temperature token validation (synthetic values)", () => {
  it.each([
    ["32.5", 3250], [" -1.2 ", -120], ["-0.1", -10], ["0.0", 0], ["-0.0", 0], ["100.0", 10000], ["-100.0", -10000],
  ])("parses %s without floating point rounding", (token, value) => {
    expect(parseTemperatureToken(token, "temperature")).toMatchObject({ kind: "NUMERIC", celsius100: value });
  });

  it.each(["", " ", "-", "--", "—", "N/A", "***", null, undefined])("rejects unavailable %s without inventing zero", (token) => {
    expect(code(() => parseTemperatureToken(token, "temperature"))).toBe("DATA_UNAVAILABLE");
  });

  it.each(["Trace", "+32.5", "32", "32.50", "01.0", "1e1", "0x10", "3 2.5", "32,5", "32.5#", "100.1", "-100.1", "1000.0", 32.5])("rejects malformed or out-of-range %s", (token) => {
    expect(code(() => parseTemperatureToken(token, "temperature"))).toBe("DATA_INVALID");
  });

  it("reads a pressure with four digits and keeps it within the metric's range", () => {
    expect([" 997.6", "1012.7"].map((token) => parseOneDecimalToken(token, "Mean Pressure (hPa)", 80000, 110000).value100)).toEqual([99760, 101270]);
    expect(code(() => parseOneDecimalToken("1100.1", "Mean Pressure (hPa)", 80000, 110000))).toBe("DATA_INVALID");
    expect(code(() => parseOneDecimalToken("1012", "Mean Pressure (hPa)", 80000, 110000))).toBe("DATA_INVALID");
    expect(code(() => parseOneDecimalToken("1012.7#", "Mean Pressure (hPa)", 80000, 110000))).toBe("DATA_INVALID");
    expect(code(() => parseOneDecimalToken("***", "Mean Pressure (hPa)", 80000, 110000))).toBe("DATA_UNAVAILABLE");
  });

  it("passes a synthetic negative temperature through the full file parser", () => {
    const raw = editSep((text) => text.replace('["14","1014.1","28.7"', '["14","1014.1","-1.2"'));
    expect(parseDailyExtractObservation(raw, "20260914", TEMP).value).toBe(-120);
  });
});

describe("shared file validation and independent metrics (synthetic edits)", () => {
  it("does not let an inconsistent rainfall total block an otherwise valid temperature", () => {
    const raw = editSep((text) => text.replace('"88"," 37.9"]', '"88"," 38.9"]'));
    expect(parseDailyExtractObservation(raw, "20260914", TEMP).value).toBe(2870);
    expect(code(() => parseDailyExtractObservation(raw, "20260914", RAIN))).toBe("DATA_INVALID");
  });

  it("does not let an unpublished temperature block a published rainfall observation", () => {
    const raw = editSep((text) => text.replace('["14","1014.1","28.7"', '["14","1014.1","***"'));
    expect(code(() => parseDailyExtractObservation(raw, "20260914", TEMP))).toBe("DATA_UNAVAILABLE");
    expect(parseDailyExtractObservation(raw, "20260914", RAIN).value).toBe(3790);
  });

  it("rejects wrong sources, dates, HTTP failures and HTML responses", () => {
    expect(code(() => parseDailyExtractObservation(SEP, "20261001", TEMP))).toBe("EVIDENCE_MISMATCH");
    expect(code(() => parseDailyExtractObservation({ ...SEP, sourceURL: "https://example.org/dailyExtract_202609.xml" }, "20260914", TEMP))).toBe("EVIDENCE_MISMATCH");
    expect(code(() => parseDailyExtractObservation(OCT, "20261005", TEMP))).toBe("DATA_UNAVAILABLE");
    expect(code(() => parseDailyExtractObservation({ ...SEP, httpStatus: 503 }, "20260914", TEMP))).toBe("DATA_UNAVAILABLE");
    expect(code(() => parseDailyExtractObservation(synthetic("<html>unavailable</html>"), "20260914", TEMP))).toBe("DATA_UNAVAILABLE");
  });

  it("rejects altered column count, duplicate keys, duplicate days and unsupported metrics", () => {
    for (const edit of [
      (text: string) => text.replace('"88"," 37.9"]', '"88"," 37.9","extra"]'),
      (text: string) => text.replace('{"month":9,', '{"month":9,"month":9,'),
      (text: string) => text.replace('["15",', '["14",'),
    ]) expect(code(() => parseDailyExtractObservation(editSep(edit), "20260914", TEMP))).toBe("DATA_INVALID");
    expect(code(() => parseDailyExtractObservation(SEP, "20260914", "MEAN_TEMPERATURE" as WeatherMetric))).toBe("DATA_INVALID");
  });
});

describe("explicitly synthetic V2 fixtures", () => {
  const fixture = demoObservationText("20261003", TEMP, "-1.2");

  it("round-trips temperature, rain and Trace with an explicit metric, unit and scale", () => {
    expect(parseDemoObservation(demo(fixture), "20261003", TEMP)).toMatchObject({ schemaVersion: 2, mode: "DEMO_FIXTURE", stationId: "DEMO", value: -120, unit: "degC", scale: 100 });
    expect(fixture).toContain('"synthetic": true');
    expect(parseDemoObservation(demo(demoObservationText("20261003", RAIN, "2.0")), "20261003", RAIN).value).toBe(200);
    expect(parseDemoObservation(demo(demoObservationText("20261003", RAIN, "Trace")), "20261003", RAIN).value).toBeNull();
  });

  it("binds demo observations to the requested metric and date", () => {
    expect(code(() => parseDemoObservation(demo(fixture), "20261003", RAIN))).toBe("EVIDENCE_MISMATCH");
    expect(code(() => parseDemoObservation(demo(fixture), "20261004", TEMP))).toBe("EVIDENCE_MISMATCH");
  });

  it("refuses wrong formats, units, scales, station, marker and oversized evidence", () => {
    const invalid = [
      "[]", "null",
      fixture.replace('"synthetic": true', '"synthetic": false'),
      fixture.replace('"stationId": "DEMO"', '"stationId": "HKO"'),
      fixture.replace('"unit": "degC"', '"unit": "mm"'),
      fixture.replace('"scale": 100', '"scale": 10'),
      `${fixture}${" ".repeat(512)}`,
      JSON.stringify({ fixtureKind: "RAINPOOL_DEMO_RAIN_FIXTURE", synthetic: true, stationId: "DEMO", targetDate: "20261003", totalRainfallMm: "2.0" }),
    ];
    for (const text of invalid) expect(code(() => parseDemoObservation(demo(text), "20261003", TEMP))).toBe("DATA_INVALID");
    expect(code(() => demoObservationText("20261003", TEMP, "Trace"))).toBe("DATA_INVALID");
  });
});
