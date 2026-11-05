import { getAddress, type Provider } from "ethers";
import { marketOf, type MetricDeployment } from "./client";
import { LOG_BLOCK_SPAN } from "./rpc-reader";

export interface MarketHolder {
  account: string;
  side: 1 | 2;
  stake: bigint;
  claimed: boolean;
}

export interface MarketTrade {
  transactionHash: string;
  logIndex: number;
  account: string;
  side: 1 | 2;
  amount: bigint;
  timestamp: number;
}

export interface MarketActivityData {
  blockNumber: number;
  blockHash: string;
  holders: MarketHolder[];
  trades: MarketTrade[];
}

export const MAX_ACTIVITY_BETS = 10_000;
const READ_CONCURRENCY = 6;
const HASH = /^0x[0-9a-fA-F]{64}$/;

interface BetRecord {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  account: string;
  side: 1 | 2;
  amount: bigint;
  cumulativeStake: bigint;
  yesTotal: bigint;
  noTotal: bigint;
}

async function mapBounded<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let index = 0; index < items.length; index += READ_CONCURRENCY) {
    result.push(...await Promise.all(items.slice(index, index + READ_CONCURRENCY).map(read)));
  }
  return result;
}

/** Reconstruct one market's bets and verify them against a single chain snapshot. */
export async function readMarketActivity(dep: MetricDeployment, reader: Provider, marketId: number): Promise<MarketActivityData> {
  if (!Number.isSafeInteger(marketId) || marketId <= 0) throw new Error("Invalid market ID for activity.");
  const [network, block] = await Promise.all([reader.getNetwork(), reader.getBlock("latest")]);
  if (network.chainId !== BigInt(dep.chainId)) throw new Error("The RPC network changed while loading market activity.");
  if (!block?.hash || !HASH.test(block.hash) || !Number.isSafeInteger(block.number)) {
    throw new Error("Unable to read the activity snapshot block.");
  }
  const firstBlock = dep.contracts.PredictionMarket.blockNumber;
  if (!Number.isSafeInteger(firstBlock) || firstBlock < 0 || firstBlock > block.number) {
    throw new Error("The market deployment is outside the current chain history. Refresh the deployment.");
  }
  const at = { blockTag: block.number };
  const market = marketOf(dep, reader);
  const state = await market.getMarketState(marketId, at);
  const records: BetRecord[] = [];
  const seen = new Set<string>();
  const blockHashes = new Map<number, string>();
  const ranges: { from: number; to: number }[] = [];
  for (let from = firstBlock; from <= block.number; from += LOG_BLOCK_SPAN) {
    ranges.push({ from, to: Math.min(block.number, from + LOG_BLOCK_SPAN - 1) });
  }
  let logCount = 0;
  const pages = await mapBounded(ranges, async ({ from, to }) => {
    const logs = await market.queryFilter(market.filters.BetPlaced(marketId), from, to);
    logCount += logs.length;
    if (logCount > MAX_ACTIVITY_BETS) {
      throw new Error(`This activity view supports up to ${MAX_ACTIVITY_BETS.toLocaleString("en-US")} bets per market. No partial history is displayed.`);
    }
    return { from, to, logs };
  });
  for (const { from, to, logs } of pages) {
    for (const log of logs) {
      const args = log.args;
      if (log.removed || !Number.isSafeInteger(log.blockNumber) || log.blockNumber < from || log.blockNumber > to
        || !Number.isSafeInteger(log.index) || log.index < 0 || !HASH.test(log.transactionHash) || !HASH.test(log.blockHash)
        || args.marketId !== BigInt(marketId) || (args.side !== 1n && args.side !== 2n)
        || args.value <= 0n || args.cumulativeStake <= 0n || args.yesTotal < 0n || args.noTotal < 0n) {
        throw new Error("The RPC returned an invalid bet record. Refresh and try again.");
      }
      const key = `${log.transactionHash.toLowerCase()}:${log.index}`;
      if (seen.has(key)) throw new Error("The RPC returned duplicate bet records. No partial history is displayed.");
      if (blockHashes.has(log.blockNumber) && blockHashes.get(log.blockNumber) !== log.blockHash) {
        throw new Error("The RPC returned conflicting blocks for the bet history. Refresh activity.");
      }
      seen.add(key);
      blockHashes.set(log.blockNumber, log.blockHash);
      records.push({
        blockNumber: log.blockNumber, blockHash: log.blockHash, transactionHash: log.transactionHash,
        logIndex: log.index, account: getAddress(args.account), side: Number(args.side) as 1 | 2,
        amount: args.value, cumulativeStake: args.cumulativeStake, yesTotal: args.yesTotal, noTotal: args.noTotal,
      });
    }
  }
  records.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  const balances = new Map<string, { account: string; side: 1 | 2; stake: bigint }>();
  let yesTotal = 0n, noTotal = 0n;
  for (const record of records) {
    const key = record.account.toLowerCase();
    const old = balances.get(key);
    const stake = (old?.stake ?? 0n) + record.amount;
    if ((old && old.side !== record.side) || stake !== record.cumulativeStake) {
      throw new Error("Bet history is incomplete or inconsistent with the account's stake. Try another RPC.");
    }
    balances.set(key, { account: record.account, side: record.side, stake });
    if (record.side === 1) yesTotal += record.amount;
    else noTotal += record.amount;
    if (yesTotal !== record.yesTotal || noTotal !== record.noTotal) {
      throw new Error("Bet history is incomplete or inconsistent with the pool. Try another RPC.");
    }
  }
  const accounts = [...balances.values()];
  if (yesTotal !== state.yesTotal || noTotal !== state.noTotal
    || BigInt(accounts.filter(item => item.side === 1).length) !== state.yesAccounts
    || BigInt(accounts.filter(item => item.side === 2).length) !== state.noAccounts) {
    throw new Error("Bet history does not match the market totals. No partial activity is displayed; try another RPC.");
  }

  const holders = await mapBounded(accounts, async (account): Promise<MarketHolder> => {
    const position = await market.getPosition(marketId, account.account, at);
    if (position.side !== BigInt(account.side) || position.stake !== account.stake) {
      throw new Error("The account position changed or does not match its bet history. Refresh activity.");
    }
    return { ...account, claimed: position.claimed };
  });
  holders.sort((a, b) => a.stake === b.stake ? a.account.localeCompare(b.account) : a.stake > b.stake ? -1 : 1);

  const blocks = [...blockHashes.keys()];
  const timestamps = new Map(await mapBounded(blocks, async (number) => {
    const item = number === block.number ? block : await reader.getBlock(number);
    if (!item?.hash || !Number.isSafeInteger(item.timestamp) || item.timestamp < 0
      || blockHashes.get(number) !== item.hash) {
      throw new Error("A bet's block is unavailable or changed. Refresh activity.");
    }
    return [number, item.timestamp] as const;
  }));
  const [unchanged, finalNetwork] = await Promise.all([reader.getBlock(block.number), reader.getNetwork()]);
  if (finalNetwork.chainId !== BigInt(dep.chainId) || unchanged?.hash !== block.hash) {
    throw new Error("The chain reorganized or restarted while loading activity. Refresh and try again.");
  }
  return {
    blockNumber: block.number, blockHash: block.hash, holders,
    trades: records.reverse().map(record => ({
      transactionHash: record.transactionHash, logIndex: record.logIndex, account: record.account,
      side: record.side, amount: record.amount, timestamp: timestamps.get(record.blockNumber)!,
    })),
  };
}
