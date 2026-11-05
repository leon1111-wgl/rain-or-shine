import type { ActivityItem } from "./activity";
import { type MarketData, byActivity, isDemo, marketTagOf, metricKindOf, phaseOf } from "./markets";

const KEY = "rain-or-shine.skipIntro";

export function readSkipIntro(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(KEY) === "1";
  } catch {
    return false; // storage blocked: show the intro
  }
}

export function writeSkipIntro(skip: boolean, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (skip) storage?.setItem(KEY, "1");
    else storage?.removeItem(KEY);
  } catch {
    return; // storage unavailable: the choice applies for this session only
  }
}

export interface IntroFigures {
  open: number;
  staked: bigint;
  bets: number;
  accounts: number;
}

export function introFigures(markets: MarketData[], items: ActivityItem[], now: bigint): IntroFigures {
  return {
    open: markets.filter((m) => phaseOf(m, now) === "OPEN").length,
    staked: markets.reduce((n, m) => n + m.total, 0n),
    bets: items.length,
    accounts: new Set(items.map((b) => b.account.toLowerCase())).size,
  };
}

export function heroMarket(markets: MarketData[], now: bigint): MarketData | undefined {
  for (const list of [markets.filter((m) => !isDemo(m)), markets.filter(isDemo)]) {
    const open = list.filter((m) => phaseOf(m, now) === "OPEN");
    if (open.length > 0) return [...open].sort(byActivity)[0];
    const next = list.filter((m) => phaseOf(m, now) === "SCHEDULED").sort((a, b) => Number(a.times.openAt - b.times.openAt))[0];
    if (next) return next;
  }
  return undefined;
}

export interface KindSummary {
  markets: number;
  open: number;
  staked: bigint;
  nextClose: bigint | null;
}

export type IntroKind = "rain" | "heat" | "custom";
export function kindSummary(markets: MarketData[], kind: IntroKind, now: bigint): KindSummary {
  const mine = markets.filter((m) => (kind === "custom" ? marketTagOf(m) === "custom" : marketTagOf(m) === "official" && metricKindOf(m.metric.code) === kind));
  const open = mine.filter((m) => phaseOf(m, now) === "OPEN");
  const closes = open.map((m) => m.times.closeAt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { markets: mine.length, open: open.length, staked: mine.reduce((n, m) => n + m.total, 0n), nextClose: closes[0] ?? null };
}
