import { describe, expect, it } from "vitest";
import { fetchRaw } from "../../src/weather/fetch.js";

describe("fetch policy: bounded retries, no fallback source (DATA-05, DATA-08)", () => {
  const response = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const noSleep = { sleep: async () => undefined, backoffMs: 1 };

  it("retries 5xx and timeouts, then returns the exact bytes with Last-Modified", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      if (calls === 2) return response(503, "busy");
      return response(200, "{}", { "last-modified": "Fri, 02 Oct 2026 02:31:06 GMT", "content-type": "text/xml" });
    };
    const raw = await fetchRaw("https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202609.xml", { ...noSleep, fetchImpl });
    expect([calls, raw.httpStatus, raw.lastModified, new TextDecoder().decode(raw.bytes)]).toEqual([3, 200, "Fri, 02 Oct 2026 02:31:06 GMT", "{}"]);
  });

  it("gives up after the budget or on a non-retryable status with DATA_UNAVAILABLE", async () => {
    let calls = 0;
    const notFound: typeof fetch = async () => {
      calls++;
      return response(404, "missing");
    };
    await expect(fetchRaw("https://x.test/a", { ...noSleep, fetchImpl: notFound })).rejects.toMatchObject({ code: "DATA_UNAVAILABLE" });
    expect(calls).toBe(1);
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchRaw("https://x.test/a", { ...noSleep, retries: 2, fetchImpl: down })).rejects.toThrow(/after 3 attempt/);
  });
});
