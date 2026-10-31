import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { encodeBase64, sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import {
  assertObservationBundle,
  buildObservationBundle,
  checkObservationBundle,
  type ObservationBundle,
} from "../../src/weather/observation-evidence.js";
import { demoObservationText, parseDailyExtractObservation, parseDemoObservation } from "../../src/weather/observations.js";
import type { RawEvidence } from "../../src/weather/parse.js";
import { WeatherDataError } from "../../src/weather/strict.js";

const DIR = "fixtures/official/hko-daily-extract";

function capture(file: string): RawEvidence {
  const name = readdirSync(DIR).find((entry) => entry.startsWith(`dailyExtract_${file}_`) && entry.endsWith(".meta.json"))!;
  const metadata = JSON.parse(readFileSync(path.join(DIR, name), "utf8")) as {
    requestUrl: string; fetchedAt: string; httpStatus: number; contentType: string; lastModified: string;
  };
  return {
    bytes: new Uint8Array(readFileSync(path.join(DIR, name.replace(".meta.json", ".raw")))),
    sourceURL: metadata.requestUrl,
    fetchedAt: metadata.fetchedAt,
    httpStatus: metadata.httpStatus,
    contentType: metadata.contentType,
    lastModified: metadata.lastModified,
  };
}

const raw = capture("202609");
const temperature = buildObservationBundle(raw, parseDailyExtractObservation(raw, "20260914", "DAILY_MAX_TEMPERATURE_C"));
const rainfall = buildObservationBundle(raw, parseDailyExtractObservation(raw, "20260914", "TOTAL_RAINFALL_MM"));
const fails = (value: unknown): string[] => checkObservationBundle(value).filter((check) => !check.ok).map((check) => check.name);

function demo(valueText = "-2.5"): ObservationBundle {
  const text = demoObservationText("20261003", "DAILY_MAX_TEMPERATURE_C", valueText);
  const fixture: RawEvidence = {
    bytes: new TextEncoder().encode(text),
    sourceURL: "fixture:temperature.json",
    fetchedAt: "2026-10-02T01:00:00.000Z",
    contentType: "application/json",
    httpStatus: null,
    lastModified: null,
  };
  return buildObservationBundle(fixture, parseDemoObservation(fixture, "20261003", "DAILY_MAX_TEMPERATURE_C"));
}

describe("weather evidence v3", () => {
  it("re-hashes and re-parses independent temperature and rain facts from the same official snapshot", () => {
    expect(temperature.observation.value).toBe(2870);
    expect(rainfall.observation.value).toBe(3790);
    expect(temperature.observation.rawSha256).toBe(rainfall.observation.rawSha256);
    for (const bundle of [temperature, rainfall]) {
      expect(checkObservationBundle(bundle, bundle.observation).filter((check) => !check.ok)).toEqual([]);
      expect(assertObservationBundle(bundle)).toBe(bundle);
    }
    expect(temperature.notes.join(" ")).toContain("does not authenticate");
  });

  it("keeps Trace separate from an exact zero", () => {
    const trace = buildObservationBundle(raw, parseDailyExtractObservation(raw, "20260913", "TOTAL_RAINFALL_MM"));
    expect(trace.observation).toMatchObject({ kind: "TRACE", value: null, valueText: "Trace" });
    expect(fails(trace)).toEqual([]);
    expect(fails({ ...trace, observation: { ...trace.observation, value: 0 } })).toContain("reparse");
  });

  it.each([
    ["schemaVersion", 1],
    ["sourceId", "UNTRUSTED"],
    ["stationId", "AIRPORT"],
    ["targetDate", "20260915"],
    ["timezone", "UTC"],
    ["windowStart", "1"],
    ["windowEnd", "2"],
    ["metric", "TOTAL_RAINFALL_MM"],
    ["unit", "mm"],
    ["scale", 10],
    ["kind", "TRACE"],
    ["value", 3000],
    ["valueText", "30.0"],
    ["excerpt", "forged excerpt"],
    ["lastModified", "fake timestamp"],
    ["parserVersion", "unverified-parser/1"],
  ])("rejects a tampered observation field: %s", (field, value) => {
    const changed = { ...temperature, observation: { ...temperature.observation, [field]: value } };
    expect(fails(changed).length).toBeGreaterThan(0);
    expect(() => assertObservationBundle(changed)).toThrow(WeatherDataError);
  });

  it("rejects cross-metric evidence even when each observation is independently valid", () => {
    const checks = checkObservationBundle(temperature, rainfall.observation);
    expect(checks.find((check) => check.name === "reparse")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "rules")?.ok).toBe(false);
    expect(() => assertObservationBundle(temperature, rainfall.observation)).toThrow(/metric, unit/);
  });

  it.each(["mode", "sourceId", "stationId", "targetDate", "windowStart", "windowEnd", "unit", "scale"] as const)(
    "binds expected event rules: %s", (field) => {
      const expected = { ...temperature.observation, [field]: field === "scale" ? 10 : "different" };
      expect(checkObservationBundle(temperature, expected).find((check) => check.name === "rules")?.ok).toBe(false);
    },
  );

  it("detects tampered bytes, hashes and declared lengths", () => {
    const changedBytes = new TextEncoder().encode(new TextDecoder().decode(raw.bytes).replace('"28.7"', '"29.7"'));
    expect(changedBytes).not.toEqual(raw.bytes);
    expect(fails({ ...temperature, raw: { ...temperature.raw, base64: encodeBase64(changedBytes) } })).toContain("rawSha256");
    expect(fails({ ...temperature, observation: { ...temperature.observation, rawSha256: sha256(new Uint8Array()) } })).toContain("rawSha256");
    expect(fails({ ...temperature, raw: { ...temperature.raw, byteLength: raw.bytes.length + 1 } })).toContain("byteLength");
  });

  it.each(["%%%", "A===", "YQ=", "YQ==\n", "YR=="])("rejects malformed or non-canonical base64 %j without throwing", (base64) => {
    const malformed = { ...temperature, raw: { ...temperature.raw, base64 } };
    expect(() => checkObservationBundle(malformed)).not.toThrow();
    expect(fails(malformed)).toContain("raw");
  });

  it.each([
    null, [], {}, "not JSON", { ...temperature, observation: null }, { ...temperature, observation: [] },
    { ...temperature, raw: null }, { ...temperature, notes: "not an array" },
    { ...temperature, observation: { ...temperature.observation, mode: "UNKNOWN" } },
    { ...temperature, observation: { ...temperature.observation, targetDate: null } },
    { ...temperature, observation: { ...temperature.observation, fetchedAt: 123 } },
    { ...temperature, observation: { ...temperature.observation, excerpt: {} } },
    { ...temperature, raw: { ...temperature.raw, byteLength: -1 } },
    { ...temperature, raw: { ...temperature.raw, httpStatus: "200" } },
  ])("returns a failed format check for malformed JSON: %#", (malformed) => {
    expect(() => checkObservationBundle(malformed)).not.toThrow();
    expect(fails(malformed)).toEqual(["format"]);
    expect(() => assertObservationBundle(malformed)).toThrow(WeatherDataError);
  });

  it.each(["20260230", "not-a-date", "2026-09-14"])("rejects malformed or noncanonical target date %s without throwing", (targetDate) => {
    const changed = { ...temperature, observation: { ...temperature.observation, targetDate } };
    expect(() => checkObservationBundle(changed)).not.toThrow();
    expect(fails(changed)).toContain("reparse");
    expect(fails(changed)).toContain("sourceUrl");
  });

  it.each([null, "", "2026-10-02", "2026-10-02T09:52:27", "2026-02-30T09:52:27Z", "2026-10-02T24:00:00Z", "2026-10-02T09:52:27+24:00"])(
    "requires a real capture timestamp with an explicit UTC offset: %s", (fetchedAt) => {
      expect(fails({ ...temperature, observation: { ...temperature.observation, fetchedAt } })).toContain("fetchedAt");
    },
  );

  it.each([null, 201, 204, 404, 503])("rejects LIVE evidence without a captured HTTP 200 status: %s", (httpStatus) => {
    const bundle = { ...temperature, raw: { ...temperature.raw, httpStatus } };
    expect(fails(bundle)).toContain("httpStatus");
  });

  it.each(["2026-10-02T09:52:27.1Z", "2026-10-02T09:52:27.1234567Z", "2026-10-02T23:52:27.1234567+14:00", "2026-10-02T09:52:27.1234567-14:00"])(
    "accepts capture precision of up to seven fractional digits and offsets up to 14 hours: %s", (fetchedAt) => {
      expect(fails({ ...temperature, observation: { ...temperature.observation, fetchedAt } })).toEqual([]);
    },
  );

  it.each(["2026-10-02T09:52:27.12345678Z", "2026-10-02T09:52:27+14:01", "2026-10-02T09:52:27-14:01", "2026-10-02T09:52:27+15:00"])(
    "rejects unsupported capture precision or UTC offsets: %s", (fetchedAt) => {
      expect(fails({ ...temperature, observation: { ...temperature.observation, fetchedAt } })).toContain("fetchedAt");
    },
  );
  it("accepts equivalent UTC offsets, rejects an incomplete daily capture and accepts the exact window boundary", () => {
    const at = (fetchedAt: string) => ({ ...temperature, observation: { ...temperature.observation, fetchedAt } });
    expect(fails(at("2026-10-02T17:52:27.625+08:00"))).toEqual([]);
    expect(fails(at("2026-09-14T23:59:59+08:00"))).toContain("completeDay");
    expect(fails(at("2026-09-15T00:00:00+08:00"))).toEqual([]);
    const fakeEnd = { ...at("2026-09-14T23:59:59+08:00"), observation: { ...temperature.observation, fetchedAt: "2026-09-14T23:59:59+08:00", windowEnd: "0" } };
    expect(fails(fakeEnd)).toContain("completeDay");
  });

  it("requires the exact official monthly URL, not a lookalike host or a yearly file", () => {
    const lookalike = { ...temperature, observation: { ...temperature.observation, sourceURL: "https://www.hko.gov.hk.attacker.test/cis/dailyExtract/dailyExtract_202609.xml" } };
    expect(fails(lookalike)).toContain("sourceUrl");
    const yearly = capture("2026");
    const fromYearly = buildObservationBundle(yearly, parseDailyExtractObservation(yearly, "20260914", "DAILY_MAX_TEMPERATURE_C"));
    expect(fails(fromYearly)).toContain("sourceUrl");
  });

  it("accepts clearly synthetic signed-temperature fixtures without treating them as actual weather", () => {
    const bundle = demo();
    expect(bundle.observation.value).toBe(-250);
    expect(fails(bundle)).toEqual([]);
    expect(bundle.notes.join(" ")).toContain("synthetic");
    expect(checkObservationBundle(bundle, temperature.observation).find((check) => check.name === "rules")?.ok).toBe(false);
  });

  it("rechecks the synthetic marker and fixture metric instead of trusting the observation label", () => {
    const bundle = demo();
    const altered = new TextDecoder().decode(new Uint8Array(Buffer.from(bundle.raw.base64, "base64"))).replace('"synthetic": true', '"synthetic": false');
    const bytes = new TextEncoder().encode(altered);
    const changed = {
      ...bundle,
      raw: { ...bundle.raw, base64: encodeBase64(bytes), byteLength: bytes.length },
      observation: { ...bundle.observation, rawSha256: sha256(bytes), excerpt: altered },
    };
    expect(fails(changed)).toContain("reparse");
    expect(fails({ ...bundle, observation: { ...bundle.observation, metric: "TOTAL_RAINFALL_MM", unit: "mm" } })).toContain("reparse");
  });

  it("enforces excerpt and synthetic fixture byte limits", () => {
    expect(fails({ ...temperature, observation: { ...temperature.observation, excerpt: "雨".repeat(200) } })).toContain("excerptSize");
    const bundle = demo();
    const bytes = new TextEncoder().encode(" ".repeat(513));
    expect(fails({ ...bundle, raw: { ...bundle.raw, base64: encodeBase64(bytes), byteLength: bytes.length } })).toContain("fixtureSize");
    expect(fails({ ...bundle, observation: { ...bundle.observation, sourceURL: "fixture:" + "a".repeat(256) } })).toContain("sourceUrlSize");
  });

  it("rejects retired rainfall evidence by kind and version", () => {
    expect(fails({ kind: "RAINPOOL_RAIN_EVIDENCE", bundleVersion: 2, reading: {} })).toEqual(["format"]);
  });
});
