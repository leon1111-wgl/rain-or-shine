import type { ReactNode } from "react";
import { useMarket } from "../hooks/useMarkets";
import { t } from "../i18n";
import { localizeChainMessage } from "../lib/chainErrors";
import type { MarketData } from "../lib/markets";
import { href } from "../lib/routes";
import { useMetricApp } from "../metric/context";
import { LoadError, Skeleton } from "./primitives";

export function MarketFrame({ id, children }: { id: number; children: (market: MarketData) => ReactNode }) {
  const api = useMetricApp();
  const { market, error, loading } = useMarket(id);
  if (loading) return <Skeleton rows={6} testId="market-loading" />;
  if (!market && error) return <LoadError error={localizeChainMessage(error)} retry={() => void api.refresh(true)} />;
  if (!market) {
    return (
      <div className="empty" data-testid="not-registered">
        <h2>{t("market.notFound")}</h2>
        <p className="subtext">{t("market.notFoundBody", { id })}</p>
        <a href={href.list}>{t("nav.back")}</a>
      </div>
    );
  }
  return (
    <>
      {error && <LoadError error={localizeChainMessage(error)} retry={() => void api.refresh(true)} />}
      {children(market)}
    </>
  );
}
