import { useState } from "react";
import { useFlash } from "../hooks/useFlash";
import { type MessageKey, t } from "../i18n";
import type { MarketStats } from "../lib/market";
import { type MarketData, marketTagOf, phaseOf, questionOf } from "../lib/markets";
import { viewOf } from "../lib/phase";
import { href } from "../lib/routes";
import { Change, Eth, InfoTip, PhaseBadge, Share, ShareBar } from "./primitives";
import { Sparkline } from "./charts";
import { Icon } from "./Icon";
import { CloseTime } from "./MarketFacts";
import { MetricMark } from "./MetricMark";

type SortKey = "share" | "change" | "volume" | "total" | "close";
type Sort = { key: SortKey; desc: boolean } | null;

const EMPTY: MarketStats = { share: null, change: null, volume: 0n, trades: 0, spark: [] };
const cmp = (a: bigint | number, b: bigint | number) => (a > b ? 1 : a < b ? -1 : 0);

function MarketRow({ market, stats, now, starred, onStar }: { market: MarketData; stats: MarketStats; now: bigint; starred: boolean; onStar: (id: number) => void }) {
  const phase = phaseOf(market, now);
  const view = viewOf(phase);
  const link = href.market(market.id, view);
  const flash = useFlash(market.yesTotal, market.noTotal);
  return (
    <tr key={flash.nonce} className={`market-row ${flash.tone ? `flash-${flash.tone}` : ""}`} data-testid="pool-card" data-phase={phase} data-market={market.id}>
      <td className="cell-event">
        <div className="event-cell">
          <button type="button" className={`star ${starred ? "on" : ""}`} aria-pressed={starred} aria-label={starred ? t("list.unstar") : t("list.star")} title={starred ? t("list.unstar") : t("list.star")} onClick={() => onStar(market.id)} data-testid="star">
            <Icon name="star" />
          </button>
          <a href={link} className="event-link">
            <MetricMark code={market.metric.code} />
            <span>
              <strong>{questionOf(market)}</strong>
              <small>
                <PhaseBadge phase={phase} tag={marketTagOf(market)} />
              </small>
            </span>
          </a>
        </div>
      </td>
      <td className="cell-share num">
        <strong>
          <Share value={stats.share} />
        </strong>
        <ShareBar yes={market.yesTotal} no={market.noTotal} />
      </td>
      <td className="cell-change num">
        <Change value={stats.change} />
      </td>
      <td className="cell-spark">
        <Sparkline values={stats.spark} />
      </td>
      <td className="cell-volume num">
        <Eth wei={stats.volume} />
      </td>
      <td className="cell-total num">
        <strong>
          <Eth wei={market.total} />
        </strong>
        <small className="split">
          <span className="yes-text">
            Yes <Eth wei={market.yesTotal} />
          </span>
          <span className="no-text">
            No <Eth wei={market.noTotal} />
          </span>
        </small>
      </td>
      <td className="cell-close">
        <CloseTime market={market} now={now} />
      </td>
      <td className="cell-action">
        <a className={`row-action ${phase === "OPEN" ? "open" : ""}`} href={link}>
          {phase === "SCHEDULED" ? t("card.action.scheduled") : t(`card.action.${view}` as MessageKey)}
        </a>
      </td>
    </tr>
  );
}

export function MarketTable({ markets, stats, now, starred, onStar }: { markets: MarketData[]; stats: Map<number, MarketStats>; now: bigint; starred: (id: number) => boolean; onStar: (id: number) => void }) {
  const [sort, setSort] = useState<Sort>(null);
  if (markets.length === 0) return null;
  const of = (m: MarketData) => stats.get(m.id) ?? EMPTY;
  const value = (m: MarketData, key: SortKey): bigint | number => {
    if (key === "share") return of(m).share ?? -1;
    if (key === "change") return of(m).change ?? -Infinity;
    if (key === "volume") return of(m).volume;
    if (key === "total") return m.total;
    return m.times.closeAt;
  };
  const rows = sort ? [...markets].sort((a, b) => cmp(value(a, sort.key), value(b, sort.key)) * (sort.desc ? -1 : 1)) : markets;
  const next = (key: SortKey): Sort => (sort?.key !== key ? { key, desc: true } : sort.desc ? { key, desc: false } : null);
  const head = (key: SortKey, label: string, className: string, tip?: string) => (
    <th scope="col" className={className} aria-sort={sort?.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className={`sort ${sort?.key === key ? (sort.desc ? "desc" : "asc") : ""}`} onClick={() => setSort(next(key))}>
        {label}
      </button>
      {tip && <InfoTip text={tip} />}
    </th>
  );
  return (
    <div className="table-scroll">
      <table className="market-table">
        <thead>
          <tr>
            <th scope="col">{t("table.event")}</th>
            {head("share", t("table.share"), "num", t("bar.caption"))}
            {head("change", t("table.change"), "num")}
            <th scope="col" className="cell-spark">
              {t("table.trend")}
            </th>
            {head("volume", t("table.volume"), "num cell-volume")}
            {head("total", t("table.total"), "num")}
            {head("close", t("table.close"), "")}
            <th scope="col">
              <span className="sr-only">{t("table.action")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <MarketRow key={m.id} market={m} stats={of(m)} now={now} starred={starred(m.id)} onStar={onStar} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
