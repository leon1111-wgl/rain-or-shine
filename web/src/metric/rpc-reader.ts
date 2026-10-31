import { FetchRequest, JsonRpcProvider, isError, type JsonRpcPayload, type JsonRpcResult } from "ethers";

/** A public Sepolia RPC without a key. Some of its servers drop old history, so old logs and receipts go back to the
 * manifest's gateway, which keeps them. */
export const SEPOLIA_FALLBACK_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** After the main RPC fails, calls start on the fallback for this long. */
const MAIN_REST_MS = 60_000;
/** When the fallback has no old receipt or log, the main RPC is asked again after each of these pauses. */
const HISTORY_PAUSES_MS = [1500, 3000, 6000];

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

/** History the node no longer keeps. publicnode answers code 4444, "pruned history unavailable". */
const prunedHistory = (results: JsonRpcResult[]) => results.some((r) => {
  const error = (r as { error?: { code?: number; message?: string } }).error;
  return error !== undefined && (error.code === 4444 || /pruned/i.test(error.message ?? ""));
});

/** A receipt the answer says does not exist. From the fallback that can mean pruned, not missing. */
function nullReceipt(payload: JsonRpcPayload | JsonRpcPayload[], results: JsonRpcResult[]): boolean {
  const ids = (Array.isArray(payload) ? payload : [payload]).filter((p) => p.method === "eth_getTransactionReceipt").map((p) => p.id);
  return results.some((r) => ids.includes(r.id) && (r as { result?: unknown }).result === null);
}

/** Keep public RPC bursts small, sharing one queue across dashboard and activity reads. With a fallback, a call the
 * main RPC cannot serve (rate limit, server error, timeout) is sent again to the fallback in the same slot. */
export class PacedReadProvider extends JsonRpcProvider {
  private pending: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private readonly connections: FetchRequest[];
  private active = 0;
  private mainRestsUntil = 0;

  constructor(request: string | FetchRequest, private readonly intervalMs = 1000, fallback?: string | FetchRequest) {
    // With somewhere else to go, the main RPC is not retried on 429. The fallback is the retry.
    const main = connectionOf(request, fallback === undefined ? 4 : 1);
    super(main, undefined, { batchMaxCount: 4, cacheTimeout: -1 });
    this.connections = [main];
    if (fallback !== undefined) {
      const second = connectionOf(fallback, 4);
      if (second.url !== main.url) this.connections.push(second);
    }
  }

  override _getConnection(): FetchRequest {
    return this.connections[this.active]!.clone();
  }

  override _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const send = async () => {
      const wait = this.nextStart - Date.now();
      if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
      this.nextStart = Date.now() + this.intervalMs;
      return this.sendAnywhere(payload);
    };
    const result = this.pending.then(send);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Each RPC in turn while one cannot serve the call. The main one rests a minute after a rate limit or an outage.
   * Missing history is not an outage: the call moves on, and the main RPC does not rest. */
  private async sendAnywhere(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const order = this.connections.length > 1 && Date.now() < this.mainRestsUntil ? [1, 0] : this.connections.map((_, i) => i);
    try {
      for (const [n, index] of order.entries()) {
        const last = n === order.length - 1;
        this.active = index;
        let busy = false;
        try {
          const results = await super._send(payload);
          if (index !== 0 && (nullReceipt(payload, results) || prunedHistory(results))) return await this.historyFromMain(payload, results);
          if (last || !(rateLimited(results) || prunedHistory(results))) return results;
          busy = rateLimited(results);
        } catch (error) {
          if (last || !unavailable(error)) throw error;
          busy = true;
        }
        if (index === 0 && busy) this.mainRestsUntil = Date.now() + MAIN_REST_MS;
      }
      throw new Error("no RPC to send to");
    } finally {
      this.active = 0;
    }
  }

  /** The fallback has dropped this history. The main RPC keeps it, so it is asked again after each pause. */
  private async historyFromMain(payload: JsonRpcPayload | JsonRpcPayload[], fromFallback: JsonRpcResult[]): Promise<JsonRpcResult[]> {
    for (const pause of HISTORY_PAUSES_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, pause));
      this.active = 0;
      try {
        const results = await super._send(payload);
        if (!rateLimited(results)) return results;
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    return fromFallback;
  }
}
