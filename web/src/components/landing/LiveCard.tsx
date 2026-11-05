import { useMarketBook } from "../../hooks/useMarkets";
import { t } from "../../i18n";
import type { ActivityItem } from "../../lib/activity";
import { stakeShare } from "../../lib/amount";
import { heroMarket } from "../../lib/landing";
import { shareAfter } from "../../lib/market";
import { type MarketData, phaseOf, questionOf } from "../../lib/markets";
import { href } from "../../lib/routes";
import { MetricMark } from "../MetricMark";
import { Countdown, Eth, ShareBar, Ticking } from "../primitives";
import { stepLine } from "../StakeChart";

const W = 300;
const H = 96;
const plotY = (share: number) => H * 0.92 - (share / 100) * H * 0.84;

function ShareSteps({ bets }: { bets: ActivityItem[] }) {
  const line = stepLine(bets.map((b) => plotY(shareAfter(b))), W);
  return (
    <svg className="live-steps" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={t("intro.card.chart")} data-testid="live-steps">
      <line className="mid" x1="0" x2={W} y1={plotY(50)} y2={plotY(50)} />
      <path className="area" d={`${line}V${H}H0Z`} />
      <path className="line" d={line} />
    </svg>
  );
}

export function LiveCard({ markets, now }: { markets: MarketData[] | undefined; now: bigint }) {
  const market = markets ? heroMarket(markets, now) : undefined;
  const book = useMarketBook(market);
  if (!markets) return <aside className="live-card" data-testid="live-card" aria-busy="true"><p className="live-empty">{t("intro.card.loading")}</p></aside>;
  if (!market) return <aside className="live-card" data-testid="live-card"><p className="live-empty">{t("intro.card.empty")}</p></aside>;
  const share = market.total === 0n ? null : stakeShare(market.yesTotal, market.total);
  const bets = book.data?.items ?? [];
  const open = phaseOf(market, now) === "OPEN";
  return (
    <aside className="live-card" data-testid="live-card">
      <div className="live-head">
        <span className="live-badge">
          <span className="live-dot" aria-hidden="true" />
          {t("intro.card.live")}
        </span>
        <MetricMark code={market.metric.code} small />
      </div>
      <p className="live-question">{questionOf(market)}</p>
      <div className="live-price">
        <strong>
          {share === null ? (
            <span className="live-none">—</span>
          ) : (
            <>
              <Ticking value={share} text={share.toFixed(1)} decimals={1} from={0} />
              <small>%</small>
            </>
          )}
        </strong>
        <span>{t("intro.card.yes")}</span>
      </div>
      <div className="live-chart">
        {book.loading && !book.data && <p className="live-empty">{t("intro.card.reading")}</p>}
        {book.error && !book.data && <p className="live-empty">{t("landing.tradeError")}</p>}
        {book.data && bets.length === 0 && <p className="live-empty">{t("intro.card.noBets")}</p>}
        {book.data && bets.length === 1 && <p className="live-empty">{t("intro.card.oneBet")}</p>}
        {bets.length >= 2 && <ShareSteps bets={bets} />}
      </div>
      {market.total > 0n && (
        <div className="live-split" data-testid="live-split">
          <ShareBar yes={market.yesTotal} no={market.noTotal} />
          <div className="live-split-legend">
            <span className="yes-text">
              Yes <Eth wei={market.yesTotal} unit />
            </span>
            <span className="no-text">
              No <Eth wei={market.noTotal} unit />
            </span>
          </div>
        </div>
      )}
      <dl className="live-stats">
        <div>
          <dt>{t("intro.card.total")}</dt>
          <dd>
            <Eth wei={market.total} unit />
          </dd>
        </div>
        <div>
          <dt>{t("intro.card.bets")}</dt>
          <dd className="num">{book.data ? bets.length : "—"}</dd>
        </div>
        <div>
          <dt>{open ? t("intro.card.closes") : t("intro.card.opens")}</dt>
          <dd>
            <Countdown target={open ? market.times.closeAt : market.times.openAt} />
          </dd>
        </div>
      </dl>
      <a className="secondary live-link" href={href.market(market.id)}>
        {t("intro.card.open")}
      </a>
    </aside>
  );
}
