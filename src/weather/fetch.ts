import type { RawEvidence } from "./parse.js";
import { WeatherDataError } from "./strict.js";

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
