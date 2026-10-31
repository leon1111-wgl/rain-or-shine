// View 1: the markets, with three tabs: the market table, rankings and trading data. Every number comes from the
// verified dashboard and the markets' bet history at read time. An RPC error is shown as an error, never as an empty
// list. Official markets lead the table. Sports demos (local chain only) come last.

import { useMemo, useState } from "react";
import { Callout, Change, LoadError, PhaseBadge, Share, Skeleton } from "../components/primitives";
import { Gauge } from "../components/Gauge";
import { HowItWorks } from "../components/HowItWorks";
import { MarketCards } from "../components/MarketCards";
import { CloseTime } from "../components/MarketFacts";
import { MarketTable } from "../components/MarketTable";
import { MetricMark } from "../components/MetricMark";
import { Rankings } from "../components/Rankings";
import { RulesDialog } from "../components/RulesDialog";
import { TradingData } from "../components/TradingData";
import { useApp } from "../hooks/useApp";
import { useActivity, useMarkets } from "../hooks/useMarkets";
import { useStars } from "../hooks/useStars";
import { type MessageKey, t } from "../i18n";
import { formatEthFixed } from "../lib/amount";
import { localizeChainMessage } from "../lib/chainErrors";
import { type MarketStats, marketStats, matchesDate, viewCounts } from "../lib/market";
import { type MarketData, type MetricKind, byActivity, isDemo, isLocalMock, marketTagOf, metricKindOf, phaseOf, questionOf, sourceOf } from "../lib/markets";
import { viewOf, type View } from "../lib/phase";
import { type ListTab, href } from "../lib/routes";

type Filter = "all" | View | "stars";
type ListState = "loading" | "error" | "ready";
const TABS: ListTab[] = ["markets", "ranks", "data"];
const FILTERS: Filter[] = ["all", "detail", "waiting", "settlement", "stars"];
const KIND_ORDER: MetricKind[] = ["rain", "heat", "humidity", "custom", "sport"];
/** A code that draws each type's icon. */
const KIND_ICON: Record<MetricKind, string> = { rain: "TOTAL_RAINFALL", heat: "DAILY_MAX_TEMPERATURE", humidity: "DAILY_MEAN_HUMIDITY", custom: "CUSTOM", sport: "SCORE_MARGIN" };

export function MarketsPage({ tab }: { tab: ListTab }) {
  const api = useApp();
  const now = api.now;
  const markets = useMarkets();
  const activity = useActivity(markets.data);
  const [filter, setFilter] = useState<Filter>("all");
  const [kind, setKind] = useState<MetricKind | "all">("all");
  const [query, setQuery] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const stars = useStars();
  const all = useMemo(() => markets.data ?? [], [markets.data]);
  const stats = useMemo(() => new Map<number, MarketStats>(all.map((m) => [m.id, marketStats(m, activity.data ?? [], Number(now))])), [all, activity.data, now]);
  const kindCounts = new Map(KIND_ORDER.map((k) => [k, all.filter((m) => metricKindOf(m.metric.code) === k).length]));
  const kinds = KIND_ORDER.filter((k) => (kindCounts.get(k) ?? 0) > 0);
  const state: ListState = markets.data ? "ready" : markets.error ? "error" : "loading";
  // Weather markets take the focus and the cards. A sports demo does only when nothing else exists.
  const weather = all.filter((m) => !isDemo(m));
  const featured = weather.length > 0 ? weather : all;
  const busiest = (list: MarketData[]) => [...list].sort(byActivity)[0];
  const focus = busiest(featured.filter((m) => phaseOf(m, now) === "OPEN")) ?? featured.find((m) => phaseOf(m, now) === "SCHEDULED") ?? featured[0];
  const counts = { ...viewCounts(all, now), stars: all.filter((m) => stars.starred(m.id)).length };
  const inFilter = (m: MarketData) => filter === "all" || (filter === "stars" ? stars.starred(m.id) : viewOf(phaseOf(m, now)) === filter);
  const matches = (m: MarketData) => inFilter(m) && (kind === "all" || metricKindOf(m.metric.code) === kind) && matchesDate(m, query);
  const emptyText = filter === "stars" && counts.stars === 0 ? t("list.noStars") : query.trim() ? t("list.noDate") : t("list.noMatch");

  return (
    <>
      <div className="market-top">
        <h1>{t("list.title")}</h1>
        <nav className="tabs page-tabs" aria-label={t("list.tabs")}>
          {TABS.map((k) => (
            <a key={k} className={`tab ${tab === k ? "active" : ""}`} href={href.tab(k)} aria-current={tab === k ? "page" : undefined} data-testid={`tab-${k}`}>
              {t(`list.tab.${k}` as MessageKey)}
            </a>
          ))}
        </nav>
        <button type="button" className="secondary small-button" onClick={() => setRulesOpen(true)}>
          {t("list.rules")}
        </button>
      </div>
      {markets.error && <LoadError error={localizeChainMessage(markets.error)} retry={() => void api.refresh(true)} />}
      {tab === "markets" && (
        <>
          {focus && <Focus market={focus} stats={stats.get(focus.id) ?? marketStats(focus, [], Number(now))} now={now} />}
          <MarketCards markets={featured} stats={stats} items={activity.data} now={now} state={state} />
          <section className="market-section" aria-label={t("list.events")}>
            <div className="section-heading">
              <div className="chips" role="group" aria-label={t("list.filter")}>
                {FILTERS.map((f) => (
                  <button key={f} type="button" className={`chip ${filter === f ? "active" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={`filter-${f}`}>
                    {t(`filter.${f}`)}
                    <span className="chip-count" data-testid={`count-${f}`}>
                      {state === "ready" ? counts[f] : "–"}
                    </span>
                  </button>
                ))}
              </div>
              {kinds.length > 1 && (
                <div className="segmented" role="group" aria-label={t("list.metric")} data-testid="metric-filter">
                  {(["all", ...kinds] as const).map((k) => (
                    <button key={k} type="button" className={kind === k ? "active" : ""} aria-pressed={kind === k} onClick={() => setKind(k)} data-testid={`kind-filter-${k}`}>
                      {k !== "all" && <MetricMark code={KIND_ICON[k]} small />}
                      {k === "all" ? t("list.metricAll") : t(`kind.${k}` as MessageKey)}
                      <span className="chip-count">{state === "ready" ? (k === "all" ? all.length : kindCounts.get(k)) : "–"}</span>
                    </button>
                  ))}
                </div>
              )}
              <input className="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("list.search")} aria-label={t("list.search")} autoComplete="off" data-testid="search" />
            </div>
            <EventLists state={state} markets={all} matches={matches} emptyText={emptyText} stats={stats} now={now} starred={stars.starred} onStar={stars.toggle} />
          </section>
          <HowItWorks hours={focus ? (focus.times.refundAt - focus.times.observationEnd) / 3_600n : 72n} />
        </>
      )}
      {tab !== "markets" && !activity.data && (activity.error ? <LoadError error={localizeChainMessage(activity.error)} retry={activity.reload} /> : <Skeleton rows={6} />)}
      {tab === "ranks" && activity.data && <Rankings markets={all} stats={stats} items={activity.data} now={now} />}
      {tab === "data" && activity.data && <TradingData markets={all} items={activity.data} now={now} />}
      {focus && isLocalMock(api.dep) && <Callout>{t("list.localNote")}</Callout>}
      {rulesOpen && <RulesDialog onClose={() => setRulesOpen(false)} />}
    </>
  );
}

/** The event in focus: its question, the Yes share in a rain gauge, the main figures and the way in. */
function Focus({ market, stats, now }: { market: MarketData; stats: MarketStats; now: bigint }) {
  const phase = phaseOf(market, now);
  return (
    <section className="focus" data-testid="focus">
      <div className="focus-main">
        <div className="focus-meta">
          <MetricMark code={market.metric.code} />
          <PhaseBadge phase={phase} tag={marketTagOf(market)} />
        </div>
        <h2>{questionOf(market)}</h2>
        <p className="focus-source">{sourceOf(market)}</p>
        <dl className="focus-figures">
          <div>
            <dt>{t("table.share")}</dt>
            <dd>
              <span className="figure">
                <Share value={stats.share} />
              </span>
              <Change value={stats.change} />
            </dd>
          </div>
          <div>
            <dt>{t("table.total")}</dt>
            <dd>
              <span className="figure">{formatEthFixed(market.total)}</span> <small>ETH</small>
            </dd>
          </div>
          <div>
            <dt>{t("table.volume")}</dt>
            <dd>
              <span className="figure">{formatEthFixed(stats.volume)}</span> <small>ETH</small>
            </dd>
          </div>
          <div>
            <CloseTime market={market} now={now} />
          </div>
        </dl>
        <a className="primary accent focus-cta" href={href.market(market.id, viewOf(phase))}>
          {phase === "OPEN" ? t("card.action.detail") : t(`card.action.${viewOf(phase)}` as MessageKey)}
        </a>
      </div>
      <Gauge share={stats.share} height={176} />
    </section>
  );
}

/** The market table. Loading, empty and no-match states say which applies. */
function EventLists({ state, markets, matches, emptyText, stats, now, starred, onStar }: { state: ListState; markets: MarketData[]; matches: (m: MarketData) => boolean; emptyText: string; stats: Map<number, MarketStats>; now: bigint; starred: (id: number) => boolean; onStar: (id: number) => void }) {
  const visible = markets.filter(matches);
  return (
    <>
      {state === "loading" && <Skeleton rows={4} testId="pools-loading" />}
      {state === "ready" && markets.length === 0 && (
        <div className="empty" data-testid="pools-empty">
          {t("list.empty")} <a href={href.ops()}>{t("list.emptyAction")}</a>
        </div>
      )}
      {markets.length > 0 && visible.length === 0 && (
        <div className="empty" data-testid="pools-no-match">
          {emptyText}
        </div>
      )}
      <MarketTable markets={visible} stats={stats} now={now} starred={starred} onStar={onStar} />
    </>
  );
}
