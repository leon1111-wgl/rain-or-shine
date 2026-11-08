import { FetchRequest, JsonRpcProvider, isError, type JsonRpcPayload, type JsonRpcResult } from "ethers";

/** A fast public Sepolia RPC without a key. The reader asks it first for current state and logs.
 * Some of its servers drop old history. Receipts go to the manifest's gateway first. Dropped logs move there too. */
export const SEPOLIA_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export function readUrls(dep: { environment: string; publicRpcUrl: string }): { current: string; history?: string } {
  return dep.environment === "SEPOLIA_UMA" ? { current: SEPOLIA_FALLBACK_RPC, history: dep.publicRpcUrl } : { current: dep.publicRpcUrl };
}
/** The most blocks that one log query may span: publicnode refuses more than 50,000. The gateway takes more. */
export const LOG_BLOCK_SPAN = 50_000;
const REST_MS = 60_000;
/** Retry pauses for a busy history RPC. The other RPC lacks the history in this case. */
const HISTORY_PAUSES_MS = [1500, 3000, 6000, 12000];
/** The history gateway rejects more than five calls per request. It gets at most this many. */
const HISTORY_BATCH = 4;
/** Calls that go to the history RPC first. Logs go to the fast RPC first. It usually still has them.
 * It reports dropped logs. The call then moves on. */
const HISTORY_METHODS = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);

type Payload = JsonRpcPayload | JsonRpcPayload[];
type Retry = { best: JsonRpcResult[] | undefined; failure: unknown };
const listOf = (payload: Payload) => (Array.isArray(payload) ? payload : [payload]);

function connectionOf(request: string | FetchRequest, maxAttempts: number): FetchRequest {
  const connection = typeof request === "string" ? new FetchRequest(request) : request.clone();
  connection.timeout = 30_000;
  connection.setThrottleParams({ maxAttempts, slotInterval: 1000 });
  return connection;
}

function unavailable(error: unknown): boolean {
  if (isError(error, "TIMEOUT")) return true;
  const status = (error as { response?: { statusCode?: number } } | null)?.response?.statusCode;
  if (status === undefined) return isError(error, "SERVER_ERROR") || isError(error, "NETWORK_ERROR");
  return status === 429 || status >= 500;
}

/** Some gateways answer a rate limit with HTTP 200 and JSON-RPC error -32005. */
const rateLimited = (results: JsonRpcResult[]) => results.some((r) => (r as { error?: { code?: number } }).error?.code === -32005);

/** History the node does not keep: publicnode's code 4444, "pruned history unavailable", or null for a receipt or for
 * a block by number. */
function missingHistory(payload: Payload, results: JsonRpcResult[]): boolean {
  const pruned = results.some((r) => {
    const error = (r as { error?: { code?: number; message?: string } }).error;
    return error !== undefined && (error.code === 4444 || /pruned/i.test(error.message ?? ""));
  });
  if (pruned) return true;
  const ids = listOf(payload)
    .filter((p) => p.method === "eth_getTransactionReceipt" || (p.method === "eth_getBlockByNumber" && /^0x/.test(String((p.params as unknown[] | undefined)?.[0]))))
    .map((p) => p.id);
  return results.some((r) => ids.includes(r.id) && (r as { result?: unknown }).result === null);
}

/** One queue for all public RPC reads keeps bursts small. One request is in flight at a time.
 * A dashboard read costs one round trip per batch. Sixteen calls per batch keep it short with many markets.
 * A second RPC with history gets the receipts first. Everything else goes to the first RPC.
 * A call can fail on one RPC from a rate limit, server error, timeout or missing history. It then moves to the other RPC in the same slot. */
export class PacedReadProvider extends JsonRpcProvider {
  private pending: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private readonly connections: FetchRequest[];
  private readonly restsUntil = [0, 0];
  private active = 0;

  constructor(request: string | FetchRequest, private readonly intervalMs = 1000, history?: string | FetchRequest) {
    // With a second RPC, a 429 is not retried here. The other RPC is the retry.
    const state = connectionOf(request, history === undefined ? 4 : 1);
    super(state, undefined, { batchMaxCount: 16, cacheTimeout: -1 });
    this.connections = [state];
    if (history !== undefined) {
      const second = connectionOf(history, 1);
      if (second.url !== state.url) this.connections.push(second);
    }
  }

  override _getConnection(): FetchRequest {
    return this.connections[this.active]!.clone();
  }

  override _send(payload: Payload): Promise<JsonRpcResult[]> {
    return this.paced(() => this.sendAnywhere(payload)).then((outcome) => ("results" in outcome ? outcome.results : this.historyAgain(payload, outcome)));
  }

  private paced<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.nextStart - Date.now();
      if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      this.nextStart = Date.now() + this.intervalMs;
      return task();
    };
    const result = this.pending.then(run);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private orderFor(payload: Payload): number[] {
    if (this.connections.length === 1) return [0];
    const first = listOf(payload).some((p) => HISTORY_METHODS.has(p.method)) ? 1 : 0;
    const now = Date.now();
    return now < this.restsUntil[first]! && now >= this.restsUntil[1 - first]! ? [1 - first, first] : [first, 1 - first];
  }

  private async sendTo(index: number, payload: Payload): Promise<JsonRpcResult[]> {
    this.active = index;
    try {
      if (index === 0 || !Array.isArray(payload) || payload.length <= HISTORY_BATCH) return await super._send(payload);
      const results: JsonRpcResult[] = [];
      for (let start = 0; start < payload.length; start += HISTORY_BATCH) {
        results.push(...await super._send(payload.slice(start, start + HISTORY_BATCH)));
      }
      return results;
    } finally {
      this.active = 0;
    }
  }

  private async sendAnywhere(payload: Payload): Promise<{ results: JsonRpcResult[] } | Retry> {
    const history = this.connections.length > 1 ? 1 : -1;
    let missing: JsonRpcResult[] | undefined;
    let limited: JsonRpcResult[] | undefined;
    let failure: unknown;
    for (const index of this.orderFor(payload)) {
      try {
        const results = await this.sendTo(index, payload);
        if (rateLimited(results)) {
          this.restsUntil[index] = Date.now() + REST_MS;
          limited ??= results;
        } else if (index !== history && history >= 0 && missingHistory(payload, results)) {
          missing = results;
        } else {
          return { results };
        }
      } catch (error) {
        if (!unavailable(error)) throw error;
        this.restsUntil[index] = Date.now() + REST_MS;
        failure = error;
      }
    }
    if (history >= 0) return { best: missing ?? limited, failure };
    if (limited) return { results: limited };
    throw failure;
  }

  private async historyAgain(payload: Payload, retry: Retry): Promise<JsonRpcResult[]> {
    let { best, failure } = retry;
    for (const pause of HISTORY_PAUSES_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, pause));
      try {
        const results = await this.paced(() => this.sendTo(1, payload));
        if (!rateLimited(results)) return results;
        best ??= results;
      } catch (error) {
        if (!unavailable(error)) throw error;
        failure = error;
      }
    }
    if (best) return best;
    throw failure;
  }
}
