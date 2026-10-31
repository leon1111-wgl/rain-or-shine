// Rankings: events by total stake, by 24 h volume and by number of addresses, and the largest single bets.

import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEthFixed } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { type MarketStats, largestBets } from "../lib/market";
import { type MarketData, phaseOf, shortLabelOf, sourceOf } from "../lib/markets";
import { viewOf } from "../lib/phase";
import { href } from "../lib/routes";
import { formatHktShort } from "../lib/time";
import { Eth, ShareBar } from "./primitives";
import { MetricMark } from "./MetricMark";

const TOP = 10;
const cmp = (a: bigint | number, b: bigint | number) => (a > b ? 1 : a < b ? -1 : 0);

function RankList({ title, markets, value, now }: { title: string; markets: MarketData[]; value: (m: MarketData) => string; now: bigint }) {
  return (
    <section className="card rank-card">
      <h2 className="card-label">{title}</h2>
      <ol className="rank-list">
        {markets.map((m, i) => (
          <li key={m.id}>
            <a href={href.market(m.id, viewOf(phaseOf(m, now)))}>
              <span className={`rank n${i + 1}`}>{i + 1}</span>
              <MetricMark code={m.metric.code} small />
              <span className="rank-name">
                <strong>{shortLabelOf(m)}</strong>
                <small>{sourceOf(m)}</small>
              </span>
              <ShareBar yes={m.yesTotal} no={m.noTotal} />
              <span className="num">{value(m)}</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LargestBets({ markets, items, now }: { markets: MarketData[]; items: ActivityItem[]; now: bigint }) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  return (
    <section className="card rank-card">
      <h2 className="card-label">{t("rank.bets")}</h2>
      <ol className="rank-list">
        {largestBets(items, TOP).map((b, i) => {
          const market = byId.get(b.market);
          return (
            <li key={`${b.txHash}:${b.logIndex}`}>
              <a href={market ? href.market(market.id, viewOf(phaseOf(market, now))) : href.list}>
                <span className={`rank n${i + 1}`}>{i + 1}</span>
                <span className="rank-name">
                  <strong className="mono">{shortHex(b.account)}</strong>
                  <small>
                    {market ? shortLabelOf(market) : ""} <time>{formatHktShort(BigInt(b.timestamp))}</time>
                  </small>
                </span>
                <span className={b.side === "YES" ? "yes-text" : "no-text"}>{b.side === "YES" ? "Yes" : "No"}</span>
                <Eth wei={b.amount} unit />
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Rankings({ markets, stats, items, now }: { markets: MarketData[]; stats: Map<number, MarketStats>; items: ActivityItem[]; now: bigint }) {
  const top = (score: (m: MarketData) => bigint | number) => [...markets].sort((a, b) => cmp(score(b), score(a))).slice(0, TOP);
  const volume = (m: MarketData) => stats.get(m.id)?.volume ?? 0n;
  const addresses = (m: MarketData) => m.yesAccounts + m.noAccounts;
  return (
    <div className="rank-grid" data-testid="rankings">
      <RankList title={t("rank.total")} markets={top((m) => m.total)} value={(m) => `${formatEthFixed(m.total)} ETH`} now={now} />
      <RankList title={t("rank.volume")} markets={top(volume)} value={(m) => `${formatEthFixed(volume(m))} ETH`} now={now} />
      <RankList title={t("rank.people")} markets={top(addresses)} value={(m) => t("table.accounts", { n: addresses(m) })} now={now} />
      <LargestBets markets={markets} items={items} now={now} />
    </div>
  );
}
