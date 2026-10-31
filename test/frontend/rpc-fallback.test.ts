// The Sepolia reader's fallback: a call the main RPC cannot serve goes to the second RPC, in the same paced queue.
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

describe("Sepolia reads with a fallback RPC", () => {
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

  it("asks the main RPC again when the fallback has pruned an old receipt", async () => {
    let receiptCalls = 0;
    const main = rpc("main", "0x1", (method, id) => (method === "eth_getTransactionReceipt" && receiptCalls++ === 0
      ? answer(200, { jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } }) : undefined));
    const backup = rpc("backup", "0x2", (method, id) => (method === "eth_getTransactionReceipt" ? answer(200, { jsonrpc: "2.0", id, result: null }) : undefined));
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_getTransactionReceipt", [`0x${"ab".repeat(32)}`])).toBe("0x1");
    expect(backup.methods).toContain("eth_getTransactionReceipt");
    expect(main.methods.filter((m) => m === "eth_getTransactionReceipt")).toHaveLength(2);
  });

  it("asks the main RPC again when the fallback has pruned old logs", async () => {
    let logCalls = 0;
    const main = rpc("main", "0x1", (method, id) => (method === "eth_getLogs" && logCalls++ === 0
      ? answer(200, { jsonrpc: "2.0", id, error: { code: -32005, message: "rate limit exceeded" } }) : undefined));
    const backup = rpc("backup", "0x2", (method, id) => (method === "eth_getLogs"
      ? answer(200, { jsonrpc: "2.0", id, error: { code: 4444, message: "pruned history unavailable" } }) : undefined));
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).toBe("0x1");
    expect(backup.methods).toContain("eth_getLogs");
    expect(main.methods.filter((m) => m === "eth_getLogs")).toHaveLength(2);
  });

  it("moves missing history from the main RPC to the fallback without resting the main RPC", async () => {
    const main = rpc("main", "0x1", (method, id) => (method === "eth_getLogs"
      ? answer(200, { jsonrpc: "2.0", id, error: { code: 4444, message: "pruned history unavailable" } }) : undefined));
    const backup = rpc("backup", "0x2");
    provider = new PacedReadProvider(main.request, 0, backup.request);
    expect(await provider.send("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }])).toBe("0x2");
    expect(await provider.send("eth_blockNumber", [])).toBe("0x1");
  });

  it("without a fallback, a failure stays a failure", async () => {
    const main = rpc("main", "0x1", (method) => (method === "eth_blockNumber" ? answer(503, {}) : undefined));
    provider = new PacedReadProvider(main.request, 0);
    await expect(provider.send("eth_blockNumber", [])).rejects.toThrow();
  });
});
