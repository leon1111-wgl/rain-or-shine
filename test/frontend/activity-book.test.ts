// @vitest-environment node
// The market's bets for the charts and the book come from the client's verified history. A market is read again only
// when its on-chain totals change.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readMarketActivity: vi.fn() }));
vi.mock("../../web/src/metric/activity", () => ({ readMarketActivity: mocks.readMarketActivity }));

import { clearActivityCache, loadActivity, loadMarketBook } from "../../web/src/lib/activity";
import type { MarketData } from "../../web/src/lib/markets";
import type { MetricDeployment } from "../../web/src/metric/client";

const dep = { chainId: 31337, bindingTransactionHash: "0xb1", contracts: { PredictionMarket: { address: "0x11" } } } as unknown as MetricDeployment;
const E = (milli: number) => BigInt(milli) * 10n ** 15n;
const market = (id: number, yes: number, no: number) => ({ id, yesTotal: E(yes), noTotal: E(no), total: E(yes + no), yesAccounts: 1, noAccounts: 1 }) as unknown as MarketData;
const trade = (account: string, side: 1 | 2, milli: number, at: number, logIndex = 0) => ({ transactionHash: `0x${at}`, logIndex, account, side, amount: E(milli), timestamp: at });

beforeEach(() => {
  clearActivityCache();
  mocks.readMarketActivity.mockReset();
});

describe("bet history", () => {
  it("replays the newest-first history into bets oldest first with each account's stake and both totals", async () => {
    mocks.readMarketActivity.mockResolvedValue({
      blockNumber: 9, blockHash: "0x9",
      holders: [{ account: "0xA", side: 1, stake: E(30), claimed: false }, { account: "0xB", side: 2, stake: E(20), claimed: true }],
      trades: [trade("0xA", 1, 20, 300), trade("0xB", 2, 20, 200), trade("0xA", 1, 10, 100)],
    });
    const book = await loadMarketBook(dep, {} as never, market(1, 30, 20));
    expect(book.items.map((b) => [b.kind, b.account, b.side, b.stake, b.yesTotal, b.noTotal, b.timestamp])).toEqual([
      ["BET", "0xA", "YES", E(10), E(10), 0n, 100],
      ["BET", "0xB", "NO", E(20), E(10), E(20), 200],
      ["TOP_UP", "0xA", "YES", E(30), E(30), E(20), 300],
    ]);
    expect(book.holders).toEqual([{ account: "0xA", side: "YES", stake: E(30), claimed: false }, { account: "0xB", side: "NO", stake: E(20), claimed: true }]);
  });

  it("reuses a market's history until its totals change, and never caches a failed read", async () => {
    mocks.readMarketActivity.mockResolvedValue({ blockNumber: 1, blockHash: "0x1", holders: [], trades: [trade("0xA", 1, 10, 100)] });
    await loadMarketBook(dep, {} as never, market(1, 10, 0));
    await loadMarketBook(dep, {} as never, market(1, 10, 0));
    expect(mocks.readMarketActivity).toHaveBeenCalledTimes(1);
    await loadMarketBook(dep, {} as never, market(1, 20, 0));
    expect(mocks.readMarketActivity).toHaveBeenCalledTimes(2);
    mocks.readMarketActivity.mockRejectedValueOnce(new Error("rpc down"));
    await expect(loadMarketBook(dep, {} as never, market(2, 5, 5))).rejects.toThrow("rpc down");
    mocks.readMarketActivity.mockResolvedValueOnce({ blockNumber: 2, blockHash: "0x2", holders: [], trades: [] });
    await expect(loadMarketBook(dep, {} as never, market(2, 5, 5))).resolves.toMatchObject({ items: [] });
  });

  it("merges every market's bets by time and skips markets without stakes", async () => {
    mocks.readMarketActivity.mockImplementation(async (_dep: unknown, _reader: unknown, id: number) => ({
      blockNumber: 1, blockHash: "0x1", holders: [], trades: id === 1 ? [trade("0xA", 1, 10, 300)] : [trade("0xB", 2, 10, 200)],
    }));
    const items = await loadActivity(dep, {} as never, [market(1, 10, 0), market(2, 0, 10), market(3, 0, 0)]);
    expect(items.map((b) => [b.market, b.timestamp])).toEqual([[2, 200], [1, 300]]);
    expect(mocks.readMarketActivity).toHaveBeenCalledTimes(2);
  });
});
