import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeBytes32String, keccak256, toUtf8Bytes, ZeroHash, type Provider } from "ethers";
import { readDashboard, type MetricDeployment } from "../../web/src/metric/client";

const mocks = vi.hoisted(() => ({ contracts: new Map<string, object>(), logs: vi.fn(), count: 2n }));
vi.mock("ethers", async original => ({
  ...await original<typeof import("ethers")>(),
  Contract: class {
    readonly target: string;
    constructor(address: string) { this.target = address; Object.assign(this, mocks.contracts.get(address)); }
  },
}));
const MARKET = "0x0000000000000000000000000000000000000011";
const ADAPTER = "0x0000000000000000000000000000000000000022";
const TOKEN = "0x0000000000000000000000000000000000000033";
const HASH = `0x${"11".repeat(32)}`;
const dep = { contracts: { PredictionMarket: { address: MARKET, blockNumber: 1 }, UmaMetricOracleAdapter: { address: ADAPTER } }, oracle: { bondCurrency: TOKEN } } as unknown as MetricDeployment;
const document = (id: number) => JSON.stringify({ title: `Event ${id}` });
const hash = (id: number) => keccak256(toUtf8Bytes(document(id)));
const event = (id: number) => ({ args: { marketId: BigInt(id), rulesDocument: toUtf8Bytes(document(id)), rulesHash: hash(id) } });
const block = { number: 20000, hash: HASH, timestamp: 1800000000 };
const reader = { getBlock: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks(); mocks.contracts.clear(); mocks.count = 2n;
  reader.getBlock.mockResolvedValue(block);
  mocks.contracts.set(MARKET, {
    metricCount: async () => 1n, marketCount: async () => mocks.count,
    getMetric: async () => ({ code: encodeBytes32String("TOTAL_RAINFALL"), unit: encodeBytes32String("mm"), minValue: 0n, maxValue: 10000n, valueStep: 1n, allowsTrace: true, rulesHash: HASH }),
    filters: { MarketCreated: () => "created" }, queryFilter: mocks.logs,
    getMarketConfig: async () => ({ condition: { metricId: 1n } }), getMarketState: async () => ({}),
    getPosition: async () => ({ side: 0n, stake: 0n }), claimable: async () => 0n,
    getAssertion: async () => ({ assertionId: ZeroHash }), getEffectiveState: async () => ({ terminal: 0n, reason: 0n }),
    marketRulesHash: async (id: number) => hash(id),
  });
  mocks.contracts.set(ADAPTER, { bondAmount: async () => 100n });
  mocks.contracts.set(TOKEN, { balanceOf: async () => 0n });
});

describe("initial dashboard history loading", () => {
  it("stops scanning once every market creation record is found and still verifies each onchain hash", async () => {
    mocks.logs.mockResolvedValue([event(1), event(2)]);
    const result = await readDashboard(dep, reader as unknown as Provider);
    expect(result.markets.map(market => market.title)).toEqual(["Event 1", "Event 2"]);
    expect(mocks.logs.mock.calls).toEqual([["created", 1, 5000]]);
    expect(reader.getBlock.mock.calls).toEqual([["latest"], [20000]]);
  });
  it("continues to later pages when some market records have not been found", async () => {
    mocks.logs.mockResolvedValueOnce([event(1)]).mockResolvedValueOnce([event(2)]);
    await expect(readDashboard(dep, reader as unknown as Provider)).resolves.toMatchObject({ markets: [{ id: 1 }, { id: 2 }] });
    expect(mocks.logs).toHaveBeenCalledTimes(2);
    expect(mocks.logs).toHaveBeenLastCalledWith("created", 5001, 10000);
  });
  it("rejects incomplete RPC history instead of displaying a partial list", async () => {
    mocks.logs.mockResolvedValue([event(1)]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(readDashboard(dep, reader as unknown as Provider)).rejects.toThrow("incomplete");
  });
  it("does not scan historical logs when no markets exist", async () => {
    mocks.count = 0n;
    await expect(readDashboard(dep, reader as unknown as Provider)).resolves.toMatchObject({ markets: [] });
    expect(mocks.logs).not.toHaveBeenCalled();
  });
  it("still rejects a creation record whose document differs from its committed hash", async () => {
    mocks.logs.mockResolvedValue([{ args: { ...event(1).args, rulesHash: ZeroHash } }, event(2)]);
    await expect(readDashboard(dep, reader as unknown as Provider)).rejects.toThrow("hash");
  });
});
