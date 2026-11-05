import type { Provider } from "ethers";
import { readMarketActivity } from "../metric/activity";
import type { MetricDeployment } from "../metric/client";
import type { MarketData, Side } from "./markets";

export type ActivityKind = "BET" | "TOP_UP";

export interface ActivityItem {
  market: number;
  kind: ActivityKind;
  account: string;
  side: Side;
  amount: bigint;
  stake: bigint;
  yesTotal: bigint;
  noTotal: bigint;
  logIndex: number;
  txHash: string;
  timestamp: number;
}

export interface Holder {
  account: string;
  side: Side;
  stake: bigint;
  claimed: boolean;
}

export interface MarketBook {
  items: ActivityItem[];
  holders: Holder[];
}

const sideOf = (side: 1 | 2): Side => (side === 1 ? "YES" : "NO");
const cache = new Map<string, Promise<MarketBook>>();

async function readBook(dep: MetricDeployment, reader: Provider, id: number): Promise<MarketBook> {
  const data = await readMarketActivity(dep, reader, id);
  const stakes = new Map<string, bigint>();
  let yes = 0n;
  let no = 0n;
  const items = [...data.trades].reverse().map((trade): ActivityItem => {
    const key = trade.account.toLowerCase();
    const before = stakes.get(key);
    const stake = (before ?? 0n) + trade.amount;
    stakes.set(key, stake);
    if (trade.side === 1) yes += trade.amount;
    else no += trade.amount;
    return {
      market: id,
      kind: before === undefined ? "BET" : "TOP_UP",
      account: trade.account,
      side: sideOf(trade.side),
      amount: trade.amount,
      stake,
      yesTotal: yes,
      noTotal: no,
      logIndex: trade.logIndex,
      txHash: trade.transactionHash,
      timestamp: trade.timestamp,
    };
  });
  return { items, holders: data.holders.map((h) => ({ account: h.account, side: sideOf(h.side), stake: h.stake, claimed: h.claimed })) };
}

export function loadMarketBook(dep: MetricDeployment, reader: Provider, m: MarketData): Promise<MarketBook> {
  const key = [dep.chainId, dep.contracts.PredictionMarket.address, dep.bindingTransactionHash, m.id, m.yesTotal, m.noTotal, m.yesAccounts, m.noAccounts].join(":");
  let entry = cache.get(key);
  if (!entry) {
    entry = readBook(dep, reader, m.id);
    cache.set(key, entry);
    entry.catch(() => cache.delete(key));
  }
  return entry;
}

export async function loadActivity(dep: MetricDeployment, reader: Provider, markets: MarketData[]): Promise<ActivityItem[]> {
  const books = await Promise.all(markets.filter((m) => m.total > 0n).map((m) => loadMarketBook(dep, reader, m)));
  return books.flatMap((b) => b.items).sort((a, b) => a.timestamp - b.timestamp || a.market - b.market || a.logIndex - b.logIndex);
}

export const clearActivityCache = () => cache.clear();
