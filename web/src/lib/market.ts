import type { ActivityItem } from "./activity";
import { stakeShare } from "./amount";
import { type MarketData, type Side, phaseOf } from "./markets";
import { viewOf, type View } from "./phase";

export const DAY_SECONDS = 86_400;
const HKT_OFFSET_SECONDS = 8 * 3_600;

const byAmountDesc = (a: { amount: bigint }, b: { amount: bigint }) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0);

export const betsOf = (items: ActivityItem[], market: number) => items.filter((i) => i.market === market);

export const shareAfter = (bet: ActivityItem) => stakeShare(bet.yesTotal, bet.yesTotal + bet.noTotal);

export function shareAt(bets: ActivityItem[], time: number): number | null {
  let last: ActivityItem | undefined;
  for (const b of bets) if (b.timestamp !== null && b.timestamp <= time) last = b;
  return last ? shareAfter(last) : null;
}

export interface MarketStats {
  share: number | null;
  change: number | null;
  volume: bigint;
  trades: number;
  spark: number[];
}

export function marketStats(market: MarketData, items: ActivityItem[], now: number): MarketStats {
  const bets = betsOf(items, market.id);
  const share = market.total === 0n ? null : stakeShare(market.yesTotal, market.total);
  const recent = bets.filter((b) => b.timestamp !== null && b.timestamp > now - DAY_SECONDS);
  const first = recent[0];
  const before = shareAt(bets, now - DAY_SECONDS) ?? (first ? shareAfter(first) : null);
  return {
    share,
    change: share !== null && before !== null ? Math.round((share - before) * 100) / 100 : null,
    volume: recent.reduce((n, b) => n + b.amount, 0n),
    trades: recent.length,
    spark: bets.map(shareAfter),
  };
}

export interface Position {
  account: string;
  side: Side;
  stake: bigint;
}

export function positionsOf(bets: ActivityItem[]): { yes: Position[]; no: Position[] } {
  const latest = new Map<string, Position>();
  for (const b of bets) latest.set(b.account.toLowerCase(), { account: b.account, side: b.side, stake: b.stake });
  const sorted = [...latest.values()].sort((a, b) => byAmountDesc({ amount: a.stake }, { amount: b.stake }));
  return { yes: sorted.filter((p) => p.side === "YES"), no: sorted.filter((p) => p.side === "NO") };
}

export interface DayBucket {
  day: string;
  yes: bigint;
  no: bigint;
  trades: number;
  accounts: number;
}

export function dailyVolume(items: ActivityItem[], days: number, now: number): DayBucket[] {
  const dayOf = (t: number) => new Date((t + HKT_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
  const buckets = new Map<string, DayBucket & { who: Set<string> }>();
  for (let d = days - 1; d >= 0; d--) {
    const day = dayOf(now - d * DAY_SECONDS);
    buckets.set(day, { day, yes: 0n, no: 0n, trades: 0, accounts: 0, who: new Set() });
  }
  for (const b of items) {
    const bucket = buckets.get(dayOf(b.timestamp));
    if (!bucket) continue;
    if (b.side === "YES") bucket.yes += b.amount;
    else bucket.no += b.amount;
    bucket.trades++;
    bucket.who.add(b.account.toLowerCase());
  }
  return [...buckets.values()].map(({ who, ...b }) => ({ ...b, accounts: who.size }));
}

export function stakeSeries(items: ActivityItem[]): Array<{ at: number; total: bigint; yes: bigint }> {
  const out: Array<{ at: number; total: bigint; yes: bigint }> = [];
  let total = 0n;
  let yes = 0n;
  for (const b of items) {
    total += b.amount;
    if (b.side === "YES") yes += b.amount;
    out.push({ at: b.timestamp, total, yes });
  }
  return out;
}

export const largestBets = (items: ActivityItem[], n: number) => [...items].sort(byAmountDesc).slice(0, n);

export interface MarketTotals {
  volume: bigint;
  trades: number;
  staked: bigint;
  paid: bigint;
  accounts: number;
}

export function marketTotals(markets: MarketData[], items: ActivityItem[], now: number): MarketTotals {
  const recent = items.filter((b) => b.timestamp > now - DAY_SECONDS);
  return {
    volume: recent.reduce((n, b) => n + b.amount, 0n),
    trades: recent.length,
    staked: markets.reduce((n, p) => n + p.total, 0n),
    paid: markets.reduce((n, p) => n + p.paidOut, 0n),
    accounts: new Set(items.map((b) => b.account.toLowerCase())).size,
  };
}

export function viewCounts(markets: MarketData[], now: bigint): Record<"all" | View, number> {
  const counts = { all: markets.length, detail: 0, waiting: 0, settlement: 0 };
  for (const p of markets) counts[viewOf(phaseOf(p, now))]++;
  return counts;
}

export function matchesDate(market: Pick<MarketData, "targetDate">, query: string): boolean {
  const text = query.trim();
  if (text === "") return true;
  const digits = text.replace(/\D/g, "");
  return digits !== "" && market.targetDate.includes(digits);
}

export function flashTone(prev: { yes: bigint; no: bigint }, next: { yes: bigint; no: bigint }): "up" | "down" | null {
  const yesDelta = next.yes - prev.yes;
  const noDelta = next.no - prev.no;
  if (yesDelta === 0n && noDelta === 0n) return null;
  return yesDelta > noDelta ? "up" : "down";
}
