import { readFileSync } from "node:fs";
import { sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import type { RawEvidence } from "../../src/weather/parse.js";
import {
  fetchTropicalCycloneWarning,
  parseTropicalCycloneWarning,
  warningSummaryUrl,
  type TropicalCycloneSignalCode,
  type WarningLanguage,
} from "../../src/weather/warnings.js";

// Warning payloads in the first describe block are synthetic. It exercises the official schema;
// it does not assert that HKO issued any warning at the dates used by these tests.
const FETCHED_AT = "2026-10-17T04:00:00.000Z";
function raw(doc: unknown, overrides: Partial<RawEvidence> = {}): RawEvidence {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(doc)),
    httpStatus: 200,
    contentType: "application/json; charset=utf-8",
    fetchedAt: FETCHED_AT,
    lastModified: null,
    sourceURL: warningSummaryUrl(),
    ...overrides,
  };
}
function entry(code = "TC3", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Tropical Cyclone Warning Signal",
    code,
    actionCode: "ISSUE",
    issueTime: "2026-10-17T10:00:00+08:00",
    updateTime: "2026-10-17T11:00:00+08:00",
    ...overrides,
  };
}
function parse(code = "TC3", overrides: Record<string, unknown> = {}) {
  return parseTropicalCycloneWarning(raw({ WTCSGNL: entry(code, overrides) }));
}

describe("HKO tropical cyclone warning snapshots", () => {
  it.each([
    ["TC1", 1, null], ["TC3", 3, null],
    ["TC8NE", 8, "NE"], ["TC8SE", 8, "SE"], ["TC8NW", 8, "NW"], ["TC8SW", 8, "SW"],
    ["TC9", 9, null], ["TC10", 10, null],
  ] as const)("maps %s without losing the No. 8 direction", (code, level, direction) => {
    const input = raw({ WTCSGNL: entry(code) });
    expect(parseTropicalCycloneWarning(input)).toMatchObject({
      schemaVersion: 1,
      sourceId: "HKO_WARNSUM",
      metric: "TROPICAL_CYCLONE_WARNING",
      scope: "CURRENT_SNAPSHOT",
      historicalCoverage: false,
      status: "ACTIVE",
      signalCode: code,
      level,
      direction,
      actionCode: "ISSUE",
      issueTime: "2026-10-17T10:00:00+08:00",
      updateTime: "2026-10-17T11:00:00+08:00",
      expireTime: null,
      fetchedAt: FETCHED_AT,
      rawSha256: sha256(input.bytes),
      sourceURL: warningSummaryUrl(),
    });
  });

  it.each(["CANCEL", "TC3", "TC8NE"] as TropicalCycloneSignalCode[])(
    "preserves cancellation and reported code %s without an active level",
    (code) => {
      expect(parse(code, { actionCode: "CANCEL", expireTime: "2026-10-17T11:00:00+08:00" })).toMatchObject({
        status: "CANCELLED", signalCode: code, actionCode: "CANCEL",
        level: null, direction: null, expireTime: "2026-10-17T11:00:00+08:00",
      });
    },
  );

  it("an empty response means no current entry, never complete historical coverage", () => {
    expect(parseTropicalCycloneWarning(raw({}))).toMatchObject({
      status: "NO_ACTIVE_WARNING", scope: "CURRENT_SNAPSHOT", historicalCoverage: false,
      signalCode: null, level: null, direction: null, issueTime: null, updateTime: null,
    });
  });

  it("does not confuse a monsoon, rainstorm or thunderstorm warning with a cyclone", () => {
    const input = raw({
      WMSGNL: entry("WMSGNL", { name: "Strong Monsoon Signal" }),
      WRAIN: entry("WRAINB", { name: "Rainstorm Warning Signal" }),
      WTS: entry("WTS", { name: "Thunderstorm Warning", actionCode: "EXTEND" }),
    });
    expect(parseTropicalCycloneWarning(input).status).toBe("NO_ACTIVE_WARNING");
  });

  it("accepts a still-active warning issued days ago and a future expiry", () => {
    expect(parse("TC1", {
      issueTime: "2026-10-15T10:00:00+08:00",
      updateTime: "2026-10-15T10:00:00+08:00",
      expireTime: "2026-10-18T10:00:00+08:00",
    }).status).toBe("ACTIVE");
  });

  it("a past expiry is unavailable data, not a no-warning response", () => {
    expect(() => parse("TC3", { expireTime: "2026-10-17T11:59:00+08:00" })).toThrow("DATA_UNAVAILABLE");
  });

  it.each(["TC2", "TC8", "TC11", "NONE", "constructor"])("rejects unknown signal code %s", (code) => {
    expect(() => parse(code)).toThrow("DATA_INVALID");
  });

  it.each(["UPDATE", "EXTEND", "REISSUE", "UNKNOWN"])("rejects unsupported tropical cyclone action %s", (actionCode) => {
    expect(() => parse("TC3", { actionCode })).toThrow("DATA_INVALID");
  });

  it("rejects CANCEL labelled ISSUE", () => {
    expect(() => parse("CANCEL")).toThrow("DATA_INVALID");
  });

  it.each([
    { WTC: entry() }, { error: "unavailable" }, { WTCSGNL: null }, { WTCSGNL: [] },
    { WTCSGNL: {} }, { WRAIN: {} }, { WRAIN: entry("TC3") },
    { WTCSGNL: entry("TC3", { name: "" }) },
    { WTCSGNL: entry("TC3", { actionCode: null }) },
    [], null, "no warnings",
  ])("rejects malformed responses instead of returning NO_ACTIVE_WARNING", (doc) => {
    expect(() => parseTropicalCycloneWarning(raw(doc))).toThrow("DATA_INVALID");
  });

  it.each([
    "2026-02-30T10:00:00+08:00", "2026-13-17T10:00:00+08:00",
    "2026-10-00T10:00:00+08:00", "2026-10-17T24:00:00+08:00",
    "2026-10-17T10:60:00+08:00", "2026-10-17T10:00:60+08:00",
    "2026-10-17T10:00:00+15:00", "2026-10-17T10:00:00+14:01",
    "2026-10-17T10:00:00+08:99", "2026-10-17T10:00:00", "yesterday", null,
  ])("rejects invalid warning timestamps %s", (issueTime) => {
    expect(() => parse("TC3", { issueTime })).toThrow("DATA_INVALID");
  });

  it("rejects update before issue, a future update and expiry before issue", () => {
    expect(() => parse("TC3", { updateTime: "2026-10-17T09:00:00+08:00" })).toThrow("DATA_INVALID");
    expect(() => parse("TC3", { updateTime: "2026-10-17T13:00:00+08:00" })).toThrow("DATA_INVALID");
    expect(() => parse("TC3", { expireTime: "2026-10-17T09:00:00+08:00" })).toThrow("DATA_INVALID");
  });

  it("allows absent or null expiry and preserves metadata", () => {
    expect(parse("TC3", { expireTime: null }).expireTime).toBeNull();
    expect(parseTropicalCycloneWarning(raw({}, { lastModified: "Sat, 17 Oct 2026 04:00:00 GMT" })).lastModified)
      .toBe("Sat, 17 Oct 2026 04:00:00 GMT");
  });

  it.each(["https://example.com/warnsum", warningSummaryUrl() + "&date=20261017", warningSummaryUrl().replace("https:", "http:")])(
    "rejects noncanonical or historical-looking URLs %s", (sourceURL) => {
      expect(() => parseTropicalCycloneWarning(raw({}, { sourceURL }))).toThrow("EVIDENCE_MISMATCH");
    },
  );

  it.each([null, 404, 500])("requires successful HTTP metadata (%s)", (httpStatus) => {
    expect(() => parseTropicalCycloneWarning(raw({}, { httpStatus }))).toThrow("DATA_UNAVAILABLE");
  });

  it.each([null, "not a time", "2026-02-30T04:00:00Z"])("requires valid fetchedAt metadata (%s)", (fetchedAt) => {
    expect(() => parseTropicalCycloneWarning(raw({}, { fetchedAt }))).toThrow("DATA_INVALID");
  });

  it("rejects HTML, invalid UTF-8, malformed JSON and duplicate warning keys", () => {
    expect(() => parseTropicalCycloneWarning(raw({}, { contentType: "text/html" }))).toThrow("DATA_UNAVAILABLE");
    expect(() => parseTropicalCycloneWarning(raw({}, { bytes: new TextEncoder().encode("<html>error</html>") }))).toThrow("DATA_UNAVAILABLE");
    expect(() => parseTropicalCycloneWarning(raw({}, { bytes: new Uint8Array([0xff]) }))).toThrow("DATA_INVALID");
    expect(() => parseTropicalCycloneWarning(raw({}, { bytes: new TextEncoder().encode("{") }))).toThrow("DATA_INVALID");
    const duplicate = '{"WTCSGNL":' + JSON.stringify(entry()) + ',"WTCSGNL":' + JSON.stringify(entry("TC10")) + '}';
    expect(() => parseTropicalCycloneWarning(raw({}, { bytes: new TextEncoder().encode(duplicate) }))).toThrow("duplicate JSON key");
  });

  it.each(["en", "sc", "tc"] as WarningLanguage[])("fetches and parses %s using the shared fetch policy", async (lang) => {
    const requests: string[] = [];
    const payload = JSON.stringify({ WTCSGNL: entry("TC10") });
    const result = await fetchTropicalCycloneWarning(lang, {
      now: () => new Date(FETCHED_AT),
      retries: 0,
      fetchImpl: (async (url) => {
        requests.push(String(url));
        return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    expect(requests).toEqual([warningSummaryUrl(lang)]);
    expect(result.snapshot.status).toBe("ACTIVE");
    expect(result.snapshot.level).toBe(10);
    expect(result.snapshot.fetchedAt).toBe(FETCHED_AT);
    expect(result.raw.bytes).toEqual(new TextEncoder().encode(payload));
  });

  it("propagates network failure without fabricating a no-warning snapshot", async () => {
    await expect(fetchTropicalCycloneWarning(undefined, {
      retries: 0,
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    })).rejects.toThrow("DATA_UNAVAILABLE");
  });

  it("rejects unsupported languages at runtime", () => {
    expect(() => warningSummaryUrl("fr" as WarningLanguage)).toThrow(RangeError);
  });
});

describe("HKO warning summary: real captured response", () => {
  it("replays the exact bytes and metadata returned by the official endpoint", () => {
    const dir = "fixtures/official/hko-warning-summary/";
    const meta = JSON.parse(readFileSync(dir + "warnsum_en_20261017T142037Z.meta.json", "utf8")) as {
      rawFile: string; requestUrl: string; fetchedAt: string; httpStatus: number;
      contentType: string; lastModified: string | null; byteLength: number; sha256: string;
    };
    const bytes = readFileSync(dir + meta.rawFile);
    expect(bytes.byteLength).toBe(meta.byteLength);
    expect(sha256(bytes)).toBe(meta.sha256);
    expect(meta.requestUrl).toBe(warningSummaryUrl());
    const snapshot = parseTropicalCycloneWarning({
      bytes, sourceURL: meta.requestUrl, fetchedAt: meta.fetchedAt,
      httpStatus: meta.httpStatus, contentType: meta.contentType, lastModified: meta.lastModified,
    });
    expect(snapshot.status).toBe("NO_ACTIVE_WARNING");
    expect(snapshot.rawSha256).toBe(meta.sha256);
    expect(snapshot.historicalCoverage).toBe(false);
  });
});
