// The cards above the market table: busiest events, closing soon, latest trades, and the live HKO panel.

import type { ReactNode } from "react";
import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import type { MarketStats } from "../lib/market";
import { type MarketData, byActivity, phaseOf, shortLabelOf } from "../lib/markets";
import { viewOf } from "../lib/phase";
import { href } from "../lib/routes";
import { formatHktStamp } from "../lib/time";
import { Change, Countdown, Eth, Share, Skeleton } from "./primitives";
import { MetricMark } from "./MetricMark";
import { HkoLivePanel } from "./HkoLivePanel";

const ROWS = 4;
const linkOf = (m: MarketData, now: bigint) => href.market(m.id, viewOf(phaseOf(m, now)));

function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="card mini-card" data-testid={testId}>
      <h2 className="card-label">{title}</h2>
      {children}
    </section>
  );
}

function Hot({ markets, stats, now }: { markets: MarketData[]; stats: Map<number, MarketStats>; now: bigint }) {
  const volume = (m: MarketData) => stats.get(m.id)?.volume ?? 0n;
  const ranked = [...markets].sort((a, b) => (volume(b) > volume(a) ? 1 : volume(b) < volume(a) ? -1 : byActivity(a, b))).slice(0, ROWS);
  return (
    <Card title={t("cards.hot")} testId="cards-hot">
      <ul className="mini-list">
        {ranked.map((m) => (
          <li key={m.id}>
            <a href={linkOf(m, now)}>
              <MetricMark code={m.metric.code} small />
              <strong>{shortLabelOf(m)}</strong>
              <span className="num">
                <Share value={stats.get(m.id)?.share ?? null} />
              </span>
              <Change value={stats.get(m.id)?.change ?? null} />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Closing({ markets, now }: { markets: MarketData[]; now: bigint }) {
  const open = markets.filter((m) => phaseOf(m, now) === "OPEN").sort((a, b) => Number(a.times.closeAt - b.times.closeAt));
  const next = markets.filter((m) => phaseOf(m, now) === "SCHEDULED").sort((a, b) => Number(a.times.openAt - b.times.openAt));
  const rows = [...open.map((m) => [m, m.times.closeAt, t("table.closesIn")] as const), ...next.map((m) => [m, m.times.openAt, t("table.opensIn")] as const)].slice(0, ROWS);
  return (
    <Card title={t("cards.closing")} testId="cards-closing">
      {rows.length === 0 && <p className="mini-empty">{t("cards.noneOpen")}</p>}
      <ul className="mini-list">
        {rows.map(([m, at, label]) => (
          <li key={m.id}>
            <a href={linkOf(m, now)}>
              <MetricMark code={m.metric.code} small />
              <strong>{shortLabelOf(m)}</strong>
              <span className="muted">{label}</span>
              <Countdown target={at} />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Latest({ markets, items, now }: { markets: MarketData[]; items: ActivityItem[]; now: bigint }) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const latest = items.slice(-ROWS).reverse();
  return (
    <Card title={t("cards.latest")} testId="cards-latest">
      {latest.length === 0 && <p className="mini-empty">{t("chart.empty")}</p>}
      <ul className="mini-list trades">
        {latest.map((b) => {
          const market = byId.get(b.market);
          return (
            <li key={`${b.txHash}:${b.logIndex}`}>
              <a href={market ? linkOf(market, now) : href.list}>
                {/* Today's trades show the time, older ones the date. The full stamp is in the tooltip. */}
                <span className="muted num" title={formatHktStamp(BigInt(b.timestamp), now)}>
                  {formatHktStamp(BigInt(b.timestamp), now).slice(0, 5)}
                </span>
                {market && <MetricMark code={market.metric.code} small />}
                <strong>{market ? shortLabelOf(market) : ""}</strong>
                <span className={b.side === "YES" ? "yes-text" : "no-text"}>{b.side === "YES" ? "Yes" : "No"}</span>
                <Eth wei={b.amount} />
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** A failed or empty market read says so here. The HKO panel is independent of the chain. */
export function MarketCards({ markets, stats, items, now, state }: { markets: MarketData[]; stats: Map<number, MarketStats>; items: ActivityItem[] | undefined; now: bigint; state: "loading" | "error" | "ready" }) {
  return (
    <div className="market-cards" data-testid="cards">
      {state === "loading" && <Skeleton rows={4} />}
      {state === "error" && <p className="cards-state">{t("cards.error")}</p>}
      {state === "ready" && markets.length === 0 && <p className="cards-state">{t("cards.none")}</p>}
      {state === "ready" && markets.length > 0 && (
        <>
          <Hot markets={markets} stats={stats} now={now} />
          <Closing markets={markets} now={now} />
          {items ? <Latest markets={markets} items={items} now={now} /> : <Skeleton rows={4} />}
        </>
      )}
      <HkoLivePanel />
    </div>
  );
}
