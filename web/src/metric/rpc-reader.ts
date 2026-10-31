import { FetchRequest, JsonRpcProvider, isError, type JsonRpcPayload, type JsonRpcResult } from "ethers";

/** A public Sepolia RPC without a key. It is fast, so the reader asks it first for current state and logs. Some of its
 * servers drop old history: receipts go to the manifest's gateway first, and logs it has dropped move there too. */
export const SEPOLIA_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** After an RPC fails or rate-limits, calls start on the other one for this long. */
const REST_MS = 60_000;
/** When the history RPC is busy and the other one has no history, the history RPC is asked again after these pauses. */
const HISTORY_PAUSES_MS = [1500, 3000, 6000, 12000];
/** The history gateway rejects a request with more than five calls, so it gets at most this many per request. */
const HISTORY_BATCH = 4;
/** Calls that go to the history RPC first. Logs go to the fast RPC first: it usually still has them, and when it has
 * dropped them it says so, and the call moves on. */
const HISTORY_METHODS = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);

type Payload = JsonRpcPayload | JsonRpcPayload[];
/** Nothing final yet: the best answer so far, or the last failure. */
type Retry = { best: JsonRpcResult[] | undefined; failure: unknown };
const listOf = (payload: Payload) => (Array.isArray(payload) ? payload : [payload]);

function connectionOf(request: string | FetchRequest, maxAttempts: number): FetchRequest {
  const connection = typeof request === "string" ? new FetchRequest(request) : request.clone();
  connection.timeout = 30_000;
  connection.setThrottleParams({ maxAttempts, slotInterval: 1000 });
  return connection;
}

/** 429, a 5xx, a timeout or no answer: worth the same call on another RPC. A JSON-RPC error is an answer. */
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

/** Keep public RPC bursts small, sharing one queue across dashboard and activity reads. With a second RPC that keeps
 * history, receipts go to it first and everything else to the first RPC. A call one RPC cannot serve (rate limit,
 * server error, timeout, missing history) goes to the other in the same slot. */
export class PacedReadProvider extends JsonRpcProvider {
  private pending: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private readonly connections: FetchRequest[];
  private readonly restsUntil = [0, 0];
  private active = 0;

  constructor(request: string | FetchRequest, private readonly intervalMs = 1000, history?: string | FetchRequest) {
    // With somewhere else to go, an RPC is not retried on 429. The other RPC is the retry.
    const state = connectionOf(request, history === undefined ? 4 : 1);
    super(state, undefined, { batchMaxCount: 8, cacheTimeout: -1 });
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

  /** Runs one task in the shared queue, starting at most one per interval. Pauses between retries happen outside it. */
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

  /** The preferred RPC for this call first, unless it is resting and the other one is not. */
  private orderFor(payload: Payload): number[] {
    if (this.connections.length === 1) return [0];
    const first = listOf(payload).some((p) => HISTORY_METHODS.has(p.method)) ? 1 : 0;
    const now = Date.now();
    return now < this.restsUntil[first]! && now >= this.restsUntil[1 - first]! ? [1 - first, first] : [first, 1 - first];
  }

  /** One RPC through `active`, inside the queue. The history RPC gets small requests, one after another. */
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

  /** Each RPC in turn while one cannot serve the call. The history RPC's own answer is final unless it is busy. */
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

  /** The history RPC was busy and the other one could not answer. Ask the history RPC again after each pause. The other
   * calls keep their places in the queue meanwhile. */
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
