import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "ethers";
import type { MetricDeployment } from "../../web/src/metric/client";
import { MAX_ACTIVITY_BETS, readMarketActivity } from "../../web/src/metric/activity";

const mocks = vi.hoisted(() => ({
  marketOf: vi.fn(), getMarketState: vi.fn(), queryFilter: vi.fn(), getPosition: vi.fn(), BetPlaced: vi.fn(),
  getNetwork: vi.fn(), getBlock: vi.fn(),
}));
vi.mock("../../web/src/metric/client", () => ({ marketOf: mocks.marketOf }));

const address = (number: number) => `0x${number.toString(16).padStart(40, "0")}`;
const hash = (number: number) => `0x${number.toString(16).padStart(64, "0")}`;
const A = address(1), B = address(2);
const NOW = 1800000000;
const dep = { chainId: 11155111, contracts: { PredictionMarket: { blockNumber: 100 } } } as MetricDeployment;
const provider = { getNetwork: mocks.getNetwork, getBlock: mocks.getBlock } as unknown as Provider;

interface Log {
  blockNumber: number; blockHash: string; transactionHash: string; index: number; removed: boolean;
  args: { marketId: bigint; account: string; side: bigint; value: bigint; cumulativeStake: bigint; yesTotal: bigint; noTotal: bigint };
}
let logs: Log[];
let latest: number;
let positions: Map<string, { side: bigint; stake: bigint; claimed: boolean }>;
let state: { yesTotal: bigint; noTotal: bigint; yesAccounts: bigint; noAccounts: bigint };

function setBets(bets: { account: string; side: 1 | 2; amount: bigint; block?: number; claimed?: boolean }[]) {
  state = { yesTotal: 0n, noTotal: 0n, yesAccounts: 0n, noAccounts: 0n };
  positions = new Map();
  logs = bets.map((bet, index) => {
    const old = positions.get(bet.account);
    const position = { side: BigInt(bet.side), stake: (old?.stake ?? 0n) + bet.amount, claimed: bet.claimed ?? old?.claimed ?? false };
    positions.set(bet.account, position);
    if (bet.side === 1) { state.yesTotal += bet.amount; if (!old) state.yesAccounts++; }
    else { state.noTotal += bet.amount; if (!old) state.noAccounts++; }
    const number = bet.block ?? 101 + index;
    return { blockNumber: number, blockHash: hash(number), transactionHash: hash(index + 1000), index, removed: false,
      args: { marketId: 7n, account: bet.account, side: BigInt(bet.side), value: bet.amount, cumulativeStake: position.stake, yesTotal: state.yesTotal, noTotal: state.noTotal } };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  latest = 105;
  setBets([{ account: A, side: 1, amount: 2n, block: 101 }, { account: B, side: 2, amount: 3n, block: 102, claimed: true }, { account: A, side: 1, amount: 4n, block: 102 }]);
  mocks.getNetwork.mockResolvedValue({ chainId: 11155111n });
  mocks.getBlock.mockImplementation(async (number: number | "latest") => {
    const n = number === "latest" ? latest : number;
    return { number: n, hash: hash(n), timestamp: NOW + n };
  });
  mocks.BetPlaced.mockReturnValue("selected-market-filter");
  mocks.queryFilter.mockImplementation(async (_filter: string, from: number, to: number) => logs.filter(log => log.blockNumber >= from && log.blockNumber <= to).reverse());
  mocks.getPosition.mockImplementation(async (_id: number, account: string) => positions.get(account.toLowerCase()));
  mocks.getMarketState.mockImplementation(async () => state);
  mocks.marketOf.mockReturnValue({ filters: { BetPlaced: mocks.BetPlaced }, queryFilter: mocks.queryFilter, getPosition: mocks.getPosition, getMarketState: mocks.getMarketState });
});

describe("market activity from chain records", () => {
  it("aggregates repeat bets for holders and keeps each trade's own amount in newest-first log order", async () => {
    const result = await readMarketActivity(dep, provider, 7);
    expect(result).toMatchObject({ blockNumber: 105, blockHash: hash(105), holders: [
      { account: A, side: 1, stake: 6n, claimed: false }, { account: B, side: 2, stake: 3n, claimed: true },
    ] });
    expect(result.trades).toEqual([
      { transactionHash: hash(1002), logIndex: 2, account: A, side: 1, amount: 4n, timestamp: NOW + 102 },
      { transactionHash: hash(1001), logIndex: 1, account: B, side: 2, amount: 3n, timestamp: NOW + 102 },
      { transactionHash: hash(1000), logIndex: 0, account: A, side: 1, amount: 2n, timestamp: NOW + 101 },
    ]);
    expect(mocks.getMarketState).toHaveBeenCalledWith(7, { blockTag: 105 });
    expect(mocks.getPosition.mock.calls).toEqual([[7, A, { blockTag: 105 }], [7, B, { blockTag: 105 }]]);
    expect(mocks.getBlock.mock.calls.filter(([number]) => number === 102)).toHaveLength(1);
    expect(mocks.BetPlaced).toHaveBeenCalledWith(7);
  });

  it("pages the selected market's log range without overlapping boundaries", async () => {
    latest = 100150;
    setBets([{ account: A, side: 1, amount: 2n, block: 50099 }, { account: B, side: 2, amount: 3n, block: 50100 }, { account: A, side: 1, amount: 4n, block: 100100 }]);
    const result = await readMarketActivity(dep, provider, 7);
    // Pages of 50,000 blocks, the most that publicnode answers in one query.
    expect(mocks.queryFilter.mock.calls).toEqual([
      ["selected-market-filter", 100, 50099], ["selected-market-filter", 50100, 100099], ["selected-market-filter", 100100, 100150],
    ]);
    expect(result.trades.map(trade => trade.amount)).toEqual([4n, 3n, 2n]);
  });

  it("returns a verified empty history for a market with no bets", async () => {
    setBets([]);
    expect(await readMarketActivity(dep, provider, 7)).toEqual({ blockNumber: 105, blockHash: hash(105), holders: [], trades: [] });
    expect(mocks.getPosition).not.toHaveBeenCalled();
    expect(mocks.getBlock.mock.calls).toEqual([["latest"], [105]]);
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid ID %s before RPC calls", async (id) => {
    await expect(readMarketActivity(dep, provider, id)).rejects.toThrow(/market ID/);
    expect(mocks.getNetwork).not.toHaveBeenCalled();
  });

  it("rejects a wrong RPC chain before constructing the market", async () => {
    mocks.getNetwork.mockResolvedValue({ chainId: 31337n });
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/network changed/);
    expect(mocks.marketOf).not.toHaveBeenCalled();
  });

  it("does not return a partial first page when a later RPC page fails", async () => {
    latest = 50200;
    mocks.queryFilter.mockImplementation(async (_filter: string, from: number) => {
      if (from > 100) throw new Error("History unavailable");
      return logs;
    });
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow("History unavailable");
  });

  it("rejects missing tail logs even when remaining records are internally consistent", async () => {
    logs = logs.slice(0, 2);
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/market totals/);
  });

  it("rejects a missing earlier log through cumulative stake and pool checks", async () => {
    logs = logs.slice(1);
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/incomplete or inconsistent/);
  });

  it("rejects an onchain position that disagrees with its indexed bets", async () => {
    positions.set(A, { side: 1n, stake: 7n, claimed: false });
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/position changed/);
  });

  it("does not turn an unavailable participant read into an empty holder table", async () => {
    mocks.getPosition.mockRejectedValue(new Error("Position unavailable"));
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow("Position unavailable");
  });

  it("rejects duplicate logs instead of counting a bet twice", async () => {
    logs.push(logs[0]!);
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/duplicate bet/);
  });

  it("rejects removed fork logs", async () => {
    logs[0]!.removed = true;
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/invalid bet record/);
  });

  it("rejects a log whose block no longer agrees with the canonical block", async () => {
    logs[0]!.blockHash = hash(999);
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/block is unavailable or changed/);
  });

  it("rejects a missing block timestamp instead of showing an invalid date", async () => {
    const original = mocks.getBlock.getMockImplementation()!;
    mocks.getBlock.mockImplementation(async (number: number | "latest") => number === 101 ? null : original(number));
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/block is unavailable/);
  });

  it("rejects a snapshot replaced during the read", async () => {
    const original = mocks.getBlock.getMockImplementation()!;
    mocks.getBlock.mockImplementation(async (number: number | "latest") => number === 105 ? { number: 105, hash: hash(999), timestamp: NOW } : original(number));
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/reorganized or restarted/);
  });

  it("rejects a network switch after successful log and position reads", async () => {
    mocks.getNetwork.mockResolvedValueOnce({ chainId: 11155111n }).mockResolvedValueOnce({ chainId: 31337n });
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/reorganized or restarted/);
  });

  it("fails explicitly above the event cap without silently truncating", async () => {
    mocks.queryFilter.mockResolvedValue(Array.from({ length: MAX_ACTIVITY_BETS + 1 }, () => logs[0]!));
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/No partial history/);
    expect(mocks.getPosition).not.toHaveBeenCalled();
  });

  it("applies the event cap across separate RPC pages", async () => {
    latest = 50200;
    mocks.queryFilter.mockImplementation(async (_filter: string, from: number) =>
      Array.from({ length: from === 100 ? 5001 : 5000 }, () => logs[0]!));
    await expect(readMarketActivity(dep, provider, 7)).rejects.toThrow(/No partial history/);
    expect(mocks.getPosition).not.toHaveBeenCalled();
  });

  it("loads independent pages concurrently with a bounded number of RPC calls", async () => {
    latest = 900100;
    const original = mocks.queryFilter.getMockImplementation()!;
    let pending = 0, peak = 0;
    mocks.queryFilter.mockImplementation(async (filter: string, from: number, to: number) => {
      pending++; peak = Math.max(peak, pending);
      await new Promise(resolve => setTimeout(resolve, 1));
      pending--;
      return original(filter, from, to);
    });
    expect((await readMarketActivity(dep, provider, 7)).trades).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("bounds simultaneous position reads and keeps all holders", async () => {
    latest = 200;
    setBets(Array.from({ length: 18 }, (_, index) => ({ account: address(index + 1), side: index % 2 ? 2 as const : 1 as const, amount: BigInt(index + 1) })));
    let pending = 0, peak = 0;
    mocks.getPosition.mockImplementation(async (_id: number, account: string) => {
      pending++; peak = Math.max(peak, pending);
      await new Promise(resolve => setTimeout(resolve, 1));
      pending--;
      return positions.get(account.toLowerCase());
    });
    const result = await readMarketActivity(dep, provider, 7);
    expect(peak).toBeLessThanOrEqual(6);
    expect(result.holders).toHaveLength(18);
    expect(result.holders[0]!.stake).toBe(18n);
  });
});
