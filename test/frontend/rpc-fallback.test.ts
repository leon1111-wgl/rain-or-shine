// The Sepolia reader: current state from the first RPC, history from the second. A call one RPC cannot serve goes to
// the other, in the same paced queue.
import { FetchRequest, toUtf8Bytes, toUtf8String, type GetUrlResponse, type JsonRpcPayload } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { PacedReadProvider } from "../../web/src/metric/rpc-reader";

type Payload = JsonRpcPayload | JsonRpcPayload[];
const answer = (statusCode: number, body: unknown): GetUrlResponse => ({
  statusCode, statusMessage: String(statusCode), headers: { "content-type": "application/json" }, body: toUtf8Bytes(JSON.stringify(body)),
});

/** A fake RPC that knows the chain and returns `block` for eth_blockNumber, unless `trouble` answers first. */
function rpc(name: string, block: string, trouble?: (method: string, id: number) => GetUrlResponse | undefined) {
  const methods: string[] = [];
  const request = new FetchRequest(`https://${name}.invalid/`);
  request.getUrlFunc = async (req) => {
    const input = JSON.parse(toUtf8String(req.body!)) as Payload;
    const list = Array.isArray(input) ? input : [input];
    methods.push(...list.map((p) => p.method));
    for (const p of list) {
      const reply = trouble?.(p.method, p.id);
      if (reply) return reply;
    }
    const results = list.map((p) => ({ jsonrpc: "2.0", id: p.id, result: p.method === "eth_chainId" ? "0xaa36a7" : block }));
    return answer(200, Array.isArray(input) ? results : results[0]);
  };
  return { request, methods };
}

let provider: PacedReadProvider | undefined;
afterEach(() => {
  provider?.destroy();
  provider = undefined;
});

describe("Sepolia reads with a state RPC and a history RPC", () => {
  it.each([
    ["a rate limit", () => answer(429, { error: "too many requests" })],
    ["a server error", () => answer(503, { error: "unavailable" })],
    ["a timeout", () => { throw Object.assign(new Error("request timeout"), { code: "TIMEOUT" }); }],
  ])("sends the same call to the fallback after %s", async (_name, fail) => {
    const main = rpc("main", "0x1", (method) => (method === "eth_blockNumber" ? fail() : undefined));
    const backup = rpc("backup", "0x2");
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_blockNumber", [])).toBe("0x2");
    expect(main.methods).toContain("eth_blockNumber");
    expect(backup.methods).toContain("eth_blockNumber");
  });

  it("treats a JSON-RPC rate limit inside a 200 answer like a 429", async () => {
    const main = rpc("main", "0x1", (method, id) => (method === "eth_blockNumber" ? answer(200, { jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } }) : undefined));
    const backup = rpc("backup", "0x2");
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_blockNumber", [])).toBe("0x2");
  });

  it("does not resend an answered call: a JSON-RPC error stays an error", async () => {
    const main = rpc("main", "0x1", (method, id) => (method === "eth_call" ? answer(200, { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } }) : undefined));
    const backup = rpc("backup", "0x2");
    provider = new PacedReadProvider(main.request, 0, backup.request);
    await expect(provider.send("eth_call", [{ to: `0x${"11".repeat(20)}`, data: "0x" }, "latest"])).rejects.toThrow();
    expect(backup.methods).not.toContain("eth_call");
  });

  it("starts on the fallback for a while after the main RPC failed, then still answers from the main one if the fallback fails", async () => {
    let mainDown = true;
    const main = rpc("main", "0x1", (method) => (method === "eth_blockNumber" && mainDown ? answer(503, {}) : undefined));
    let backupDown = false;
    const backup = rpc("backup", "0x2", (method) => (method === "eth_blockNumber" && backupDown ? answer(503, {}) : undefined));
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_blockNumber", [])).toBe("0x2");
    const mainCalls = main.methods.filter((m) => m === "eth_blockNumber").length;
    expect(await provider.send("eth_blockNumber", [])).toBe("0x2");
    expect(main.methods.filter((m) => m === "eth_blockNumber").length).toBe(mainCalls);
    mainDown = false;
    backupDown = true;
    expect(await provider.send("eth_blockNumber", [])).toBe("0x1");
  });

  it("sends receipts to the history RPC first, and state calls and logs to the state RPC first", async () => {
    const state = rpc("state", "0x1");
    const history = rpc("history", "0x2");
    provider = new PacedReadProvider(state.request, 0, history.request);
    expect(await provider.send("eth_getTransactionReceipt", [`0x${"ef".repeat(32)}`])).toBe("0x2");
    expect(state.methods).not.toContain("eth_getTransactionReceipt");
    expect(await provider.send("eth_blockNumber", [])).toBe("0x1");
    expect(await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).toBe("0x1");
    expect(history.methods).not.toContain("eth_blockNumber");
    expect(history.methods).not.toContain("eth_getLogs");
  });

  it("asks the history RPC again when it is busy and the state RPC has pruned old logs", async () => {
    let logCalls = 0;
    const state = rpc("state", "0x1", (method, id) => (method === "eth_getLogs"
      ? answer(200, { jsonrpc: "2.0", id, error: { code: 4444, message: "pruned history unavailable" } }) : undefined));
    const history = rpc("history", "0x2", (method, id) => (method === "eth_getLogs" && logCalls++ === 0
      ? answer(200, { jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } }) : undefined));
    provider = new PacedReadProvider(state.request, 0, history.request);
    expect(await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).toBe("0x2");
    expect(state.methods).toContain("eth_getLogs");
    expect(history.methods.filter((m) => m === "eth_getLogs")).toHaveLength(2);
  });

  it("asks the history RPC again when it is busy and the state RPC has no old receipt", async () => {
    let receiptCalls = 0;
    const state = rpc("state", "0x1", (method, id) => (method === "eth_getTransactionReceipt" ? answer(200, { jsonrpc: "2.0", id, result: null }) : undefined));
    const history = rpc("history", "0x2", (method, id) => (method === "eth_getTransactionReceipt" && receiptCalls++ === 0
      ? answer(200, { jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } }) : undefined));
    provider = new PacedReadProvider(state.request, 0, history.request);
    expect(await provider.send("eth_getTransactionReceipt", [`0x${"ab".repeat(32)}`])).toBe("0x2");
    expect(state.methods).toContain("eth_getTransactionReceipt");
    expect(history.methods.filter((m) => m === "eth_getTransactionReceipt")).toHaveLength(2);
  });

  it("sends a block the state RPC has dropped to the history RPC, without resting the state RPC", async () => {
    const state = rpc("state", "0x1", (method, id) => (method === "eth_getBlockByNumber" ? answer(200, { jsonrpc: "2.0", id, result: null }) : undefined));
    const history = rpc("history", "0x2");
    provider = new PacedReadProvider(state.request, 0, history.request);
    expect(await provider.send("eth_getBlockByNumber", ["0x10", false])).toBe("0x2");
    expect(await provider.send("eth_blockNumber", [])).toBe("0x1");
  });

  it("sends logs the state RPC has pruned to the history RPC, at most four calls per request", async () => {
    const state = rpc("state", "0x1", (method, id) => (method === "eth_getLogs"
      ? answer(200, { jsonrpc: "2.0", id, error: { code: 4444, message: "pruned history unavailable" } }) : undefined));
    const sizes: number[] = [];
    const history = rpc("history", "0x2");
    const plain = history.request.getUrlFunc!;
    history.request.getUrlFunc = async (req, signal) => {
      const body = JSON.parse(toUtf8String(req.body!)) as Payload;
      sizes.push(Array.isArray(body) ? body.length : 1);
      return plain(req, signal);
    };
    provider = new PacedReadProvider(state.request, 0, history.request);
    const logs = Array.from({ length: 7 }, (_, i) => provider!.send("eth_getLogs", [{ fromBlock: `0x${i + 1}`, toBlock: `0x${i + 1}` }]));
    expect(await Promise.all(logs)).toEqual(Array(7).fill("0x2"));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
  });

  it("takes the history RPC's own empty answer as final", async () => {
    const state = rpc("state", "0x1");
    const history = rpc("history", "0x2", (method, id) => (method === "eth_getTransactionReceipt" ? answer(200, { jsonrpc: "2.0", id, result: null }) : undefined));
    provider = new PacedReadProvider(state.request, 0, history.request);
    expect(await provider.send("eth_getTransactionReceipt", [`0x${"cd".repeat(32)}`])).toBeNull();
    expect(state.methods).not.toContain("eth_getTransactionReceipt");
  });

  it("without a fallback, a failure stays a failure", async () => {
    const main = rpc("main", "0x1", (method) => (method === "eth_blockNumber" ? answer(503, {}) : undefined));
    provider = new PacedReadProvider(main.request, 0);
    await expect(provider.send("eth_blockNumber", [])).rejects.toThrow();
  });
});
