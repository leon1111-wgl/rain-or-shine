import { type MessageKey, t } from "../i18n";
import { type MarketData, phaseOf } from "../lib/markets";
import { viewOf, type View } from "../lib/phase";
import { href } from "../lib/routes";

/** Back link and the three views of one market. Says where the market's current phase belongs. */
export function MarketNav({ market, view, now }: { market: MarketData; view: View; now: bigint }) {
  const phase = phaseOf(market, now);
  const current = viewOf(phase);
  return (
    <div className="back-row pool-nav">
      <a className="text-button" href={href.list}>
        {t("nav.back")}
      </a>
      <nav className="view-tabs" aria-label={t("nav.poolViews")}>
        {(["detail", "waiting", "settlement"] as const).map((v) => (
          <a key={v} className={`stage-tab ${v === view ? "active" : ""}`} href={href.market(market.id, v)} aria-current={v === view ? "page" : undefined}>
            {t(`view.${v}` as MessageKey)}
          </a>
        ))}
      </nav>
      {current !== view && (
        <a className="small view-hint" href={href.market(market.id, current)} data-testid="view-hint">
          {t("nav.phaseElsewhere", { phase: t(`phase.${phase}` as MessageKey), view: t(`view.${current}` as MessageKey) })}
        </a>
      )}
    </div>
  );
}
