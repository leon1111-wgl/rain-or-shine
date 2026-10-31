// Trading data across every market: the last 24 h, daily volume, total stake over time, the Yes share of all stakes
// over time, and daily active addresses. Plotted in ETH fractions. Every label is the exact integer amount.

import type { ReactNode } from "react";
import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEthFixed, stakeShare } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { DAY_SECONDS, type DayBucket, dailyVolume, largestBets, marketTotals, stakeSeries } from "../lib/market";
import { type MarketData, metricNameOf, metricShortOf, phaseOf, shortLabelOf } from "../lib/markets";
import { href } from "../lib/routes";
import { formatHktShort } from "../lib/time";
import { MetricMark } from "./MetricMark";
import { Eth, InfoTip, ShareBar } from "./primitives";
import { type Bar, BarChart, type ChartPoint, TimeChart } from "./charts";

/** Days shown: from the first bet (at least a week, at most 30 days). */
const MIN_DAYS = 7;
const MAX_DAYS = 30;
const eth = (wei: bigint) => Number(wei / 10n ** 12n) / 1e6;
const when = (x: number) => formatHktShort(BigInt(x));

function ChartCard({ title, tip, empty, legend, children }: { title: string; tip?: string; empty: boolean; legend?: boolean; children: ReactNode }) {
  return (
    <section className="card chart-card">
      <div className="panel-heading">
        <h2>
          {title} {tip && <InfoTip text={tip} />}
        </h2>
        {legend && (
          <div className="legend">
            <span className="yes-text">
              <i className="swatch yes" /> Yes
            </span>
            <span className="no-text">
              <i className="swatch no" /> No
            </span>
          </div>
        )}
      </div>
      {empty ? <p className="chart-empty-box">{t("chart.empty")}</p> : children}
    </section>
  );
}

function volumeBars(days: DayBucket[]): Bar[] {
  return days.map((d) => ({
    key: d.day,
    label: d.day.slice(5),
    parts: [
      { value: eth(d.yes), tone: "yes" },
      { value: eth(d.no), tone: "no" },
    ],
    title: (
      <>
        <span className="yes-text">Yes {formatEthFixed(d.yes)}</span>
        <span className="no-text">No {formatEthFixed(d.no)}</span>
        <span>{t("data.tradesN", { n: d.trades })}</span>
      </>
    ),
  }));
}

function sharePoints(series: ReturnType<typeof stakeSeries>): ChartPoint[] {
  return series.map((s) => {
    const share = stakeShare(s.yes, s.total);
    return {
      x: s.at,
      y: share,
      label: (
        <>
          <span className="yes-text">Yes {share.toFixed(1)}%</span>
          <span className="no-text">No {(100 - share).toFixed(1)}%</span>
        </>
      ),
    };
  });
}

interface MetricRow {
  code: string;
  markets: number;
  open: number;
  staked: bigint;
  yes: bigint;
  volume: bigint;
}

/** Every metric's markets, open markets, stakes, Yes/No split and last 24 h volume. */
function metricRows(markets: MarketData[], items: ActivityItem[], now: bigint): MetricRow[] {
  const rows = new Map<string, MetricRow>();
  const codeOf = new Map(markets.map((m) => [m.id, m.metric.code]));
  for (const m of markets) {
    const row = rows.get(m.metric.code) ?? { code: m.metric.code, markets: 0, open: 0, staked: 0n, yes: 0n, volume: 0n };
    row.markets++;
    if (phaseOf(m, now) === "OPEN") row.open++;
    row.staked += m.total;
    row.yes += m.yesTotal;
    rows.set(m.metric.code, row);
  }
  for (const b of items) {
    const row = rows.get(codeOf.get(b.market) ?? "");
    if (row && b.timestamp > Number(now) - DAY_SECONDS) row.volume += b.amount;
  }
  return [...rows.values()].sort((a, b) => (b.staked > a.staked ? 1 : b.staked < a.staked ? -1 : 0));
}

function ByMetric({ rows }: { rows: MetricRow[] }) {
  return (
    <section className="card table-card" aria-labelledby="by-metric">
      <div className="panel-heading">
        <h2 id="by-metric">{t("data.byMetric")}</h2>
      </div>
      <div className="table-scroll">
        <table className="data-table" data-testid="by-metric">
          <thead>
            <tr>
              <th scope="col">{t("data.col.metric")}</th>
              <th scope="col" className="num">{t("data.col.markets")}</th>
              <th scope="col" className="num">{t("data.col.open")}</th>
              <th scope="col" className="num">{t("data.col.staked")}</th>
              <th scope="col" className="num">{t("data.col.volume")}</th>
              <th scope="col">{t("data.col.split")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td>
                  <span className="metric-cell" title={metricNameOf(r.code)}>
                    <MetricMark code={r.code} small />
                    {metricShortOf(r.code)}
                  </span>
                </td>
                <td className="num">{r.markets}</td>
                <td className="num">{r.open}</td>
                <td className="num">
                  <Eth wei={r.staked} />
                </td>
                <td className="num">
                  <Eth wei={r.volume} />
                </td>
                <td>
                  <span className="split-cell">
                    <ShareBar yes={r.yes} no={r.staked - r.yes} />
                    <span className="num">{r.staked === 0n ? "—" : `${stakeShare(r.yes, r.staked).toFixed(1)}%`}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BiggestBets({ markets, items }: { markets: MarketData[]; items: ActivityItem[] }) {
  const byId = new Map(markets.map((m) => [m.id, m]));
  const top = largestBets(items, 6);
  return (
    <section className="card table-card" aria-labelledby="big-bets">
      <div className="panel-heading">
        <h2 id="big-bets">{t("rank.bets")}</h2>
      </div>
      {top.length === 0 ? (
        <p className="chart-empty-box">{t("chart.empty")}</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" data-testid="largest-bets">
            <thead>
              <tr>
                <th scope="col">{t("tape.time")}</th>
                <th scope="col">{t("table.event")}</th>
                <th scope="col">{t("book.address")}</th>
                <th scope="col">{t("tape.side")}</th>
                <th scope="col" className="num">{t("tape.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {top.map((b) => {
                const m = byId.get(b.market);
                return (
                  <tr key={`${b.txHash}:${b.logIndex}`}>
                    <td className="num muted">{formatHktShort(BigInt(b.timestamp))}</td>
                    <td>
                      {m ? (
                        <a className="metric-cell" href={href.market(m.id)}>
                          <MetricMark code={m.metric.code} small />
                          {shortLabelOf(m)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono">{shortHex(b.account)}</td>
                    <td className={b.side === "YES" ? "yes-text" : "no-text"}>{b.side === "YES" ? "Yes" : "No"}</td>
                    <td className="num">
                      <Eth wei={b.amount} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function TradingData({ markets, items, now }: { markets: MarketData[]; items: ActivityItem[]; now: bigint }) {
  const total = marketTotals(markets, items, Number(now));
  const series = stakeSeries(items);
  const first = series[0]?.at ?? Number(now);
  const span = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.ceil((Number(now) - first) / DAY_SECONDS) + 1));
  const days = dailyVolume(items, span, Number(now));
  const empty = series.length === 0;
  const open = markets.filter((m) => phaseOf(m, now) === "OPEN").length;
  const kpis: Array<[string, ReactNode]> = [
    [t("data.volume"), <Eth wei={total.volume} unit />],
    [t("data.trades"), <span className="num">{total.trades}</span>],
    [t("data.staked"), <Eth wei={total.staked} unit />],
    [t("data.openMarkets"), <span className="num">{open}</span>],
    [t("data.accounts"), <span className="num">{total.accounts}</span>],
    [t("data.paid"), <Eth wei={total.paid} unit />],
  ];
  return (
    <div className="data-view" data-testid="trading-data">
      <dl className="summary-strip">
        {kpis.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="data-grid">
        <ChartCard title={t("data.daily")} empty={empty} legend>
          <BarChart bars={volumeBars(days)} axis={(v) => v.toFixed(3)} />
        </ChartCard>
        <ChartCard title={t("data.total")} empty={empty}>
          <TimeChart tone="neutral" points={series.map((s) => ({ x: s.at, y: eth(s.total), label: <span>{formatEthFixed(s.total)} ETH</span> }))} axis={(y) => y.toFixed(3)} xLabel={when} />
        </ChartCard>
        <ChartCard title={t("data.ratio")} tip={t("bar.caption")} empty={empty}>
          <TimeChart tone="yes" reference={50} domain={[0, 100]} ticks={[0, 50, 100]} points={sharePoints(series)} axis={(y) => `${y.toFixed(0)}%`} xLabel={when} />
        </ChartCard>
        <ChartCard title={t("data.active")} empty={empty}>
          <BarChart bars={days.map((d) => ({ key: d.day, label: d.day.slice(5), parts: [{ value: d.accounts, tone: "neutral" }], title: <span>{t("data.accountsN", { n: d.accounts })}</span> }))} axis={(v) => v.toFixed(0)} />
        </ChartCard>
      </div>
      <div className="data-grid">
        <ByMetric rows={metricRows(markets, items, now)} />
        <BiggestBets markets={markets} items={items} />
      </div>
    </div>
  );
}
