// The markets of the dashboard as the interface sees them, one market by ID, and the verified bet history.

import { useMemo } from "react";
import { useMetricApp } from "../metric/context";
import { loadActivity, loadMarketBook } from "../lib/activity";
import { type MarketData, marketsFrom } from "../lib/markets";
import { useAsync } from "./useAsync";

export interface MarketsState {
  data: MarketData[] | undefined;
  error: string | null;
  loading: boolean;
}

export function useMarkets(): MarketsState {
  const api = useMetricApp();
  const data = useMemo(() => (api.data ? marketsFrom(api.dep, api.data) : undefined), [api.dep, api.data]);
  return { data, error: api.fault || null, loading: !api.data && !api.fault };
}

export function useMarket(id: number): { market: MarketData | undefined; error: string | null; loading: boolean } {
  const markets = useMarkets();
  return { market: markets.data?.find((m) => m.id === id), error: markets.error, loading: markets.loading };
}

const totalsKey = (markets: MarketData[]) => markets.map((m) => `${m.id}:${m.yesTotal}:${m.noTotal}:${m.yesAccounts}:${m.noAccounts}`).join(",");

/** Everyone's bets in `markets`, re-read only when a market's totals change. */
export function useActivity(markets: MarketData[] | undefined) {
  const api = useMetricApp();
  const list = markets ?? [];
  const identity = `${api.dep.chainId}|${api.dep.contracts.PredictionMarket.address}`;
  return useAsync(() => loadActivity(api.dep, api.reader, list), `${identity}|${totalsKey(list)}`, { enabled: markets !== undefined, identity });
}

/** One market's verified bets and holders. */
export function useMarketBook(market: MarketData | undefined) {
  const api = useMetricApp();
  const identity = `${api.dep.chainId}|${api.dep.contracts.PredictionMarket.address}|${market?.id ?? 0}`;
  return useAsync(
    async () => {
      if (!market) throw new Error("no market");
      return loadMarketBook(api.dep, api.reader, market);
    },
    `${identity}|${market ? totalsKey([market]) : ""}`,
    { enabled: market !== undefined, identity },
  );
}
