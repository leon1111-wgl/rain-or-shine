import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import type { RawEvidence } from "../../src/weather/parse.js";
import { parseDailyExtractObservation } from "../../src/weather/observations.js";
import { WeatherDataError, formatMm100, parseRainfallToken } from "../../src/weather/strict.js";
import { dailyExtractMonthUrl, dailyExtractYearUrl, hkDayWindow } from "../../src/weather/profile.js";

const DIR = "fixtures/official/hko-daily-extract";
const rainfall = (raw: RawEvidence, targetDate: string) => parseDailyExtractObservation(raw, targetDate, "TOTAL_RAINFALL_MM");
interface Meta {
  requestUrl: string;
  fetchedAt: string;
  httpStatus: number;
  contentType: string;
  lastModified: string | null;
}

function capture(file: string): RawEvidence {
  const metaName = readdirSync(DIR).find((f) => f.startsWith(`dailyExtract_${file}_`) && f.endsWith(".meta.json"));
  if (!metaName) throw new Error(`no capture for ${file}`);
  const meta = JSON.parse(readFileSync(path.join(DIR, metaName), "utf8")) as Meta;
  const bytes = new Uint8Array(readFileSync(path.join(DIR, metaName.replace(".meta.json", ".raw"))));
  return { bytes, contentType: meta.contentType, httpStatus: meta.httpStatus, fetchedAt: meta.fetchedAt, lastModified: meta.lastModified, sourceURL: meta.requestUrl };
}

const SEP = capture("202609");
const OCT = capture("202610");

function edited(edit: (text: string) => string, extra: Partial<RawEvidence> = {}): RawEvidence {
  return { ...SEP, ...extra, bytes: new TextEncoder().encode(edit(new TextDecoder().decode(SEP.bytes))) };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof WeatherDataError) return err.code;
    throw err;
  }
  return "OK";
}

describe("real Daily Extract captures (DATA-01, DATA-02)", () => {
  it("reads the Hong Kong Observatory Total Rainfall of the requested day from the monthly file", () => {
    const r = rainfall(SEP, "20260914");
    expect(r).toMatchObject({ mode: "LIVE_HKO", sourceId: "HKO_DAILY_EXTRACT", stationId: "HKO", targetDate: "20260914", kind: "NUMERIC", value: 3790, valueText: "37.9" });
    expect(r.excerpt).toBe('["14","1014.1","28.7","27.8","26.1","24.8","84","88"," 37.9"]');
    expect(r.sourceURL).toBe(dailyExtractMonthUrl("20260914"));
    expect(r.rawSha256).toBe(sha256(SEP.bytes));
  });

  it("covers a small numeric value, zero, Trace and another month", () => {
    const cases: Array<[RawEvidence, string, string, number | null]> = [
      [SEP, "20260911", "NUMERIC", 90],
      [SEP, "20260903", "NUMERIC", 0],
      [SEP, "20260913", "TRACE", null],
      [SEP, "20260915", "NUMERIC", 180],
      [OCT, "20261001", "NUMERIC", 0],
    ];
    for (const [raw, date, kind, mm100] of cases) {
      const r = rainfall(raw, date);
      expect([r.kind, r.value], date).toEqual([kind, mm100]);
    }
  });

  it("handles the year boundary with the 12-column yearly files (DATA-06)", () => {
    const dec = rainfall(capture("2025"), "20251231");
    const jan = rainfall(capture("2026"), "20260101");
    expect([dec.targetDate, dec.valueText, jan.targetDate, jan.valueText]).toEqual(["20251231", "0.0", "20260101", "0.0"]);
    expect(dec.sourceURL).toBe(dailyExtractYearUrl(2025));
  });

  it("binds the day label to the Hong Kong calendar day D 00:00 to D+1 00:00 (UTC+8)", () => {
    const r = rainfall(SEP, "20260914");
    expect([r.windowStart, r.windowEnd]).toEqual([String(Date.UTC(2026, 8, 13, 16) / 1000), String(Date.UTC(2026, 8, 14, 16) / 1000)]);
    expect(hkDayWindow("20260914").end - hkDayWindow("20260914").start).toBe(86_400n);
  });

  it("refuses a file that does not contain the requested date and a day that is not published yet", () => {
    expect(code(() => rainfall(SEP, "20261001"))).toBe("EVIDENCE_MISMATCH");
    expect(code(() => rainfall(OCT, "20261005"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => rainfall(capture("2026"), "20261001"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => rainfall({ ...SEP, sourceURL: "https://example.org/dailyExtract_202609.xml" }, "20260914"))).toBe("EVIDENCE_MISMATCH");
  });
});

describe("rainfall tokens: precision, Trace and missing values (DATA-03, DATA-04, DATA-05)", () => {
  it("parses exact one-decimal values without determining a market outcome", () => {
    expect(parseRainfallToken("  1.0", "x")).toEqual({ kind: "NUMERIC", mm100: 100, text: "1.0" });
    expect(parseRainfallToken(" 37.9", "x").mm100).toBe(3790);
    expect(parseRainfallToken("0.0", "x").mm100).toBe(0);
  });

  it("keeps Trace as its own category with null for the unknown exact value", () => {
    expect(parseRainfallToken("Trace", "x")).toEqual({ kind: "TRACE", mm100: 0, text: "Trace" });
    expect(code(() => parseRainfallToken("trace", "x"))).toBe("DATA_INVALID");
  });

  it("never turns blank, dashes, *** or nulls into 0", () => {
    for (const token of ["", "   ", "-", "--", "—", "N/A", "***", " ***"]) expect(code(() => parseRainfallToken(token, "x")), JSON.stringify(token)).toBe("DATA_UNAVAILABLE");
    expect(code(() => parseRainfallToken(null, "x"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => parseRainfallToken(undefined, "x"))).toBe("DATA_UNAVAILABLE");
  });

  it("rejects precision beyond the published format instead of rounding, and other malformed values", () => {
    for (const token of ["1.05", "1.00", "1", "-1.0", "1e1", "0x10", "10000.0", "12.3#", " 3.0#", "1,0"]) {
      expect(code(() => parseRainfallToken(token, "x")), token).toBe("DATA_INVALID");
    }
    expect(code(() => parseRainfallToken(1, "x"))).toBe("DATA_INVALID");
  });

  it("formats hundredths without rounding", () => {
    expect([formatMm100(3790), formatMm100(100), formatMm100(5), formatMm100(0n)]).toEqual(["37.9", "1.0", "0.05", "0.0"]);
  });
});

describe("SYNTHETIC edits of the real file: structure, duplicates and revisions (DATA-05, DATA-06)", () => {
  it("rejects a duplicated day row and an unknown row label", () => {
    expect(code(() => rainfall(edited((t) => t.replace('["15",', '["14","1014.1","28.7","27.8","26.1","24.8","84","88"," 37.9"],\n["15",')), "20260914"))).toBe("DATA_INVALID");
    expect(code(() => rainfall(edited((t) => t.replace('["Normal",', '["Average",')), "20260914"))).toBe("DATA_INVALID");
  });

  it("rejects a changed column layout, duplicate JSON keys and a duplicated month", () => {
    expect(code(() => rainfall(edited((t) => t.replace('"88"," 37.9"]', '"88"," 37.9","extra"]')), "20260914"))).toBe("DATA_INVALID");
    expect(code(() => rainfall(edited((t) => t.replace('{"month":9,', '{"month":9,"month":9,')), "20260914"))).toBe("DATA_INVALID");
    expect(code(() => rainfall(edited((t) => t.replace('"data":[', '"data":[{"month":9,"dayData":[]},')), "20260914"))).toBe("DATA_INVALID");
    expect(code(() => rainfall(edited(() => '{"stn":{"rows":[]}}'), "20260914"))).toBe("DATA_INVALID");
  });

  it("treats a missing month, an HTML page, HTTP errors and a *** day as unavailable, never as 0", () => {
    expect(code(() => rainfall(edited((t) => t.replace('{"month":9,', '{"month":8,')), "20260914"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => rainfall(edited(() => "<html><body>Service unavailable</body></html>"), "20260914"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => rainfall({ ...SEP, httpStatus: 404 }, "20260914"))).toBe("DATA_UNAVAILABLE");
    expect(code(() => rainfall(edited((t) => t.replace('"88"," 37.9"]', '"88","***"]')), "20260914"))).toBe("DATA_UNAVAILABLE");
  });

  it("rejects an inconsistent snapshot where a revised day no longer adds up to the published monthly total", () => {
    expect(code(() => rainfall(edited((t) => t.replace('"88"," 37.9"]', '"88"," 38.9"]')), "20260914"))).toBe("DATA_INVALID");
  });

  it("the real September total equals the sum of its days (the check passes on official data)", () => {
    expect(() => rainfall(SEP, "20260901")).not.toThrow();
  });
});
