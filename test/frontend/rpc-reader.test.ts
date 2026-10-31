import { FetchRequest, toUtf8Bytes, toUtf8String, type JsonRpcPayload } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacedReadProvider } from "../../web/src/metric/rpc-reader";
import { errorMessage } from "../../web/src/metric/client";

const payload = (id: number): JsonRpcPayload => ({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] });
const response = (request: FetchRequest, status = 200) => {
  const input = JSON.parse(toUtf8String(request.body!)) as JsonRpcPayload | JsonRpcPayload[];
  const result = (item: JsonRpcPayload) => ({ jsonrpc: "2.0", id: item.id, result: item.method === "eth_chainId" ? "0xaa36a7" : "0x10" });
  return { statusCode: status, statusMessage: status === 200 ? "OK" : "Unavailable", headers: {}, body: toUtf8Bytes(JSON.stringify(Array.isArray(input) ? input.map(result) : result(input))) };
};
let provider: PacedReadProvider | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { provider?.destroy(); provider = undefined; vi.useRealTimers(); });

describe("paced public RPC reads", () => {
  it("serializes HTTP batches and spaces their start times even when many callers arrive together", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const starts: number[] = [];
    let active = 0, peak = 0;
    const request = new FetchRequest("https://rpc.invalid");
    request.getUrlFunc = async req => {
      starts.push(Date.now()); active++; peak = Math.max(peak, active);
      if (starts.length === 1) await gate;
      active--; return response(req);
    };
    provider = new PacedReadProvider(request);
    const pending = [provider._send(payload(1)), provider._send(payload(2)), provider._send(payload(3))];
    await vi.advanceTimersByTimeAsync(500);
    expect(starts).toEqual([0]);
    release();
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all(pending);
    expect(peak).toBe(1);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("lets the next request proceed after an HTTP failure instead of deadlocking the queue", async () => {
    let count = 0;
    const request = new FetchRequest("https://rpc.invalid");
    request.getUrlFunc = async req => response(req, ++count === 1 ? 503 : 200);
    provider = new PacedReadProvider(request);
    const failed = provider._send(payload(1)).catch(error => error);
    const next = provider._send(payload(2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await failed).toBeInstanceOf(Error);
    await expect(next).resolves.toEqual([{ jsonrpc: "2.0", id: 2, result: "0x10" }]);
  });

  it("splits concurrent RPC calls into batches of at most eight while still checking the network", async () => {
    const calls: JsonRpcPayload[][] = [];
    const request = new FetchRequest("https://rpc.invalid");
    request.getUrlFunc = async req => {
      const input = JSON.parse(toUtf8String(req.body!));
      calls.push(Array.isArray(input) ? input : [input]);
      return response(req);
    };
    provider = new PacedReadProvider(request);
    const pending = Promise.all(Array.from({ length: 10 }, () => provider!.send("eth_blockNumber", [])));
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toEqual(Array(10).fill("0x10"));
    expect(calls.every(batch => batch.length <= 8)).toBe(true);
    expect(calls.flat().filter(call => call.method === "eth_blockNumber")).toHaveLength(10);
    expect(calls.flat().some(call => call.method === "eth_chainId")).toBe(true);
  });

  it("explains retry exhaustion as a rate limit rather than suggesting a deployment mismatch", () => {
    expect(errorMessage(new Error("exceeded maximum retry limit"))).toContain("RPC is rate-limiting requests");
  });
});
