import type { RawEvidence } from "./parse.js";
import { WeatherDataError, decodeUtf8, parseJsonStrict } from "./strict.js";
import { ryesRainfallToken } from "./live.js";
import { HKO_DAILY_EXTRACT_PROFILE, ryesUrl, toCompactDate } from "./profile.js";

export interface FetchPolicy {
  timeoutMs: number;
  retries: number;
  backoffMs: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = {
  timeoutMs: 15_000,
  retries: 3,
  backoffMs: 1_000,
  fetchImpl: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
};

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchRaw(url: string, policy: Partial<FetchPolicy> = {}): Promise<RawEvidence> {
  const p = { ...DEFAULT_FETCH_POLICY, ...policy };
  let lastError = "no attempt made";
  for (let attempt = 0; attempt <= p.retries; attempt++) {
    if (attempt > 0) await p.sleep(p.backoffMs * 2 ** (attempt - 1));
    try {
      const response = await p.fetchImpl(url, { signal: AbortSignal.timeout(p.timeoutMs), redirect: "error" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 200) {
        return {
          bytes,
          contentType: response.headers.get("content-type"),
          httpStatus: response.status,
          fetchedAt: p.now().toISOString(),
          lastModified: response.headers.get("last-modified"),
          sourceURL: url,
        };
      }
      lastError = `HTTP ${response.status}`;
      if (!isRetryableStatus(response.status)) break;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      lastError = `${(err as Error).name}: ${(err as Error).message}${cause ? ` (${cause})` : ""}`;
    }
  }
  throw new WeatherDataError("DATA_UNAVAILABLE", `${url} failed after ${p.retries + 1} attempt(s): ${lastError}`);
}

export async function fetchDailyExtractIndex(policy: Partial<FetchPolicy> = {}): Promise<{ endYear: number; endMonth: number }> {
  const raw = await fetchRaw(HKO_DAILY_EXTRACT_PROFILE.indexFile, policy);
  const doc = parseJsonStrict(decodeUtf8(raw.bytes)) as { hko?: Array<Record<string, unknown>> };
  const entry = doc.hko?.find((e) => e.code === "dailyExtract");
  if (!entry || !Number.isInteger(entry.endYear) || !Number.isInteger(entry.endMonth)) {
    throw new WeatherDataError("DATA_INVALID", "hko.xml has no dailyExtract entry with endYear/endMonth");
  }
  return { endYear: entry.endYear as number, endMonth: entry.endMonth as number };
}

export async function fetchRyesRainfall(date: string, policy: Partial<FetchPolicy> = {}): Promise<{ raw: RawEvidence; value: string }> {
  const compact = toCompactDate(date);
  const raw = await fetchRaw(ryesUrl(compact), policy);
  const doc = parseJsonStrict(decodeUtf8(raw.bytes)) as Record<string, unknown>;
  if (doc.ReportTimeInfoDate !== compact) throw new WeatherDataError("DATA_UNAVAILABLE", `RYES has no report for ${compact} yet`);
  return { raw, value: ryesRainfallToken(doc.HKOReadingsRainfall) };
}
