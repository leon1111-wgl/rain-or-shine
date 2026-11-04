// View 2: event details and betting, laid out like a trading screen: the event bar with the Yes share as its
// price, the chart, the positions and latest trades, the bet panel, and below them the trades, rules and rules
// document. All dates are the market's fixed on-chain times.

import { type ReactNode, useState } from "react";
import { dailyExtractMonthUrl } from "@shared/weather/profile";
import { ActivityFeed } from "../components/ActivityFeed";
import { BetPanel } from "../components/BetPanel";
import { HkoLivePanel } from "../components/HkoLivePanel";
import { Callout, Change, InfoTip, Msg, PhaseBadge, Share, ShortHash, Ticking } from "../components/primitives";
import { MetricMark } from "../components/MetricMark";
import { Icon } from "../components/Icon";
import { CloseTime } from "../components/MarketFacts";
import { MarketFrame } from "../components/MarketFrame";
import { MarketList } from "../components/MarketList";
import { MarketNav } from "../components/MarketNav";
import { PositionBook } from "../components/PositionBook";
import { StakeChart } from "../components/StakeChart";
import { useApp } from "../hooks/useApp";
import type { AsyncState } from "../hooks/useAsync";
import { useMarketBook } from "../hooks/useMarkets";
import { type HkoDailyExtractField } from "@shared/metric/custom-profile";
import { type MessageKey, activeLocale, t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEthFixed } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { webHref } from "../lib/links";
import { marketStats } from "../lib/market";
import { type MarketData, conditionOf, conditionWithUnitOf, hkoFieldMarketOf, isLocalMock, marketTagOf, metricNameOf, phaseOf, questionOf, sourceOf, unitOf, windowOf } from "../lib/markets";
import { href } from "../lib/routes";
import { formatDuration, formatHktMinute, formatHktMinuteBare, formatLocalDate } from "../lib/time";
import { downloadText } from "../metric/context";

/** "Column 6 of the day-5 row in HKO's Daily Extract for November (…)", in the reader's language. */
function hkoFieldProcedureText(field: HkoDailyExtractField, market: MarketData): string {
  const date = market.targetDate;
  const month = Number(date.slice(4, 6));
  return t("hkoField.procedure", {
    month: activeLocale() === "zh-CN" ? String(month) : new Date(Date.UTC(2000, month - 1, 1)).toLocaleString("en-GB", { month: "long", timeZone: "UTC" }),
    day: Number(date.slice(6, 8)),
    column: field.column,
    name: metricNameOf(market.metric.code),
    format: t(field.format === "percent" ? "hkoField.percent" : "hkoField.decimal"),
  });
}

/** The rules document's own wording, kept one click away: it is the canonical text. */
function OriginalText({ text }: { text: string }) {
  return (
    <details className="original-text" data-testid="custom-procedure">
      <summary>{t("hkoField.original")}</summary>
      <span className="pre-wrap">{text}</span>
    </details>
  );
}

/** A custom market's source as its creator typed it: a link for a web address, plain text for anything else. */
function SourceLink({ url }: { url: string }) {
  const link = webHref(url);
  return link ? (
    <a href={link} target="_blank" rel="noreferrer" className="break-all" data-testid="custom-source-url">{url}</a>
  ) : (
    <span className="break-all" data-testid="custom-source-url">{url}</span>
  );
}

function RulesGrid({ market }: { market: MarketData }) {
  const { dep } = useApp();
  const tm = market.times;
  const s = market.subject;
  const custom = s.kind === "CUSTOM" ? s : null;
  const sports = s.kind === "SYNTHETIC" ? s : null;
  const field = hkoFieldMarketOf(market);
  const waitHours = (tm.refundAt - tm.observationEnd) / 3_600n;
  const window = <Msg k="rule.dateWindow" params={{ from: formatHktMinuteBare(tm.observationStart), to: formatHktMinute(tm.observationEnd) }} />;
  // [label, value, optional second line]: long notes go on their own line instead of wrapping mid-phrase.
  const hko = s.kind === "HKO" || !!field;
  // The spec first, in the order a reader checks it: question, source, condition, close, observation, results,
  // deadline and what happens otherwise. Details follow.
  const entries: Array<[string, ReactNode, ReactNode?]> = [
    [t("rule.question"), questionOf(market)],
    custom
      ? [t("rule.sourceCustom"), field ? t("source.hko") : custom.sourceName, <SourceLink url={custom.sourceUrl} />]
      : sports
        ? [t("rule.sourceCustom"), sourceOf(market), t("rule.match", { a: sports.teamA, b: sports.teamB, match: sports.matchId })]
        : [t("rule.source"), sourceOf(market), t("rule.subjectHko")],
    [t("rule.condition"), conditionWithUnitOf(market), market.metric.allowsTrace ? t("rule.traceNote") : undefined],
    [t("rule.close"), formatHktMinute(tm.closeAt)],
    (custom && !custom.targetDate) || sports
      ? [t("rule.window"), windowOf(market), window]
      : [t("rule.date"), t("rule.dateValue", { date: formatLocalDate(market.targetDate) }), window],
    [t("rule.results"), <Msg k="rule.resultsValue" params={{ from: formatHktMinute(tm.earliestAssertionAt), to: formatHktMinute(tm.proposalCutoff) }} />, t(hko ? "rule.lateHko" : "rule.lateCustom")],
    [t("rule.refundAt"), formatHktMinute(tm.refundAt), t("rule.refundAtNote", { hours: waitHours })],
    [t("rule.exit"), t("rule.exitValue"), t("rule.exitNote")],
    [t("rule.metric"), metricNameOf(market.metric.code), t("rule.metricNote", { code: market.metric.code, unit: unitOf(market.metric.unit) })],
    ...(custom
      ? [[t("rule.procedure"), field ? hkoFieldProcedureText(field, market) : t("rule.procedureValue"), field ? <OriginalText text={custom.procedure} /> : <span className="pre-wrap" data-testid="custom-procedure">{custom.procedure}</span>] as [string, ReactNode, ReactNode]]
      : sports
        ? [[t("rule.procedure"), t("rule.procedureSports"), t(sports.sport === "BASKETBALL" ? "rule.scopeBasketball" : "rule.scopeFootball")] as [string, ReactNode, ReactNode]]
        : []),
    [t("rule.open"), formatHktMinute(tm.openAt)],
    [t("rule.decision"), t("rule.decisionValue"), custom || sports ? t("rule.decisionNoteCustom") : t("rule.decisionNote")],
    [t("rule.join"), t("rule.joinValue"), t("rule.joinNote")],
    [t("rule.oracle"), isLocalMock(dep) ? t("oracle.localMock") : t("oracle.canonical"), <Msg k="rule.oracleNote" params={{ liveness: formatDuration(tm.assertionLiveness), proposer: shortHex(market.proposer) }} />],
  ];
  return (
    <div className="rules-grid">
      {entries.map(([label, value, note]) => (
        <div className="rule" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
          {note && <small>{note}</small>}
        </div>
      ))}
      {s.kind === "HKO" && (
        <div className="rule">
          <span>{t("rule.file")}</span>
          <strong>
            <a href={dailyExtractMonthUrl(s.targetDate)} target="_blank" rel="noreferrer">
              {dailyExtractMonthUrl(s.targetDate).replace("https://www.hko.gov.hk", "")}
            </a>
          </strong>
        </div>
      )}
    </div>
  );
}

/** The rules document from the creation log. The client has already checked it against the market's hash. */
function RulesDocument({ market }: { market: MarketData }) {
  let pretty = market.view.rulesDocument;
  try {
    pretty = JSON.stringify(JSON.parse(market.view.rulesDocument), null, 2);
  } catch (err) {
    // A plain UTF-8 document is valid. It is shown as written.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return (
    <div>
      <p className="small muted fingerprint">
        {t("fingerprint.rules")} <InfoTip text={t("fingerprint.rulesTip")} /> <ShortHash value={market.view.rulesHash} testId="rules-fingerprint" />
      </p>
      <p className="small yes-text" data-testid="rules-hash-check">
        {t("doc.match")}
      </p>
      <pre className="doc-text">{pretty}</pre>
      <button type="button" className="secondary small-button" onClick={() => downloadText(`market-${market.id}-rules.json`, market.view.rulesDocument)}>
        {t("doc.download")}
      </button>
    </div>
  );
}

function Rules({ market }: { market: MarketData }) {
  return (
    <>
      <div className="metric-band">
        <div className="value">
          {market.condition.comparison === 5 ? conditionWithUnitOf(market) : (
            <>
              {conditionOf(market)} <span>{unitOf(market.metric.unit)}</span>
            </>
          )}
        </div>
        <div className="divider" />
        <div>
          <strong className="small">{metricNameOf(market.metric.code)}</strong>
          <p className="small muted">{t(market.subject.kind === "CUSTOM" ? "detail.metricNoteCustom" : market.subject.kind === "SYNTHETIC" ? "detail.metricNoteSports" : "detail.metricNote")}</p>
        </div>
      </div>
      <RulesGrid market={market} />
      {market.subject.kind === "CUSTOM" && <Callout testId="custom-note">{t("detail.customNote")}</Callout>}
      {market.subject.kind === "SYNTHETIC" && <Callout testId="demo-note">{t("detail.demoNote")}</Callout>}
      {market.subject.kind === "UNRECOGNIZED" && <Callout testId="unrecognized-note">{t("detail.unrecognizedNote")}</Callout>}
    </>
  );
}

/** The event, its Yes share as the price with the 24 h change, and the live figures. A changed total flashes. */
function EventBar({ market, bets }: { market: MarketData; bets: ActivityItem[] }) {
  const { now, isAdmin } = useApp();
  const s = marketStats(market, bets, Number(now));
  const stats: Array<[ReactNode, ReactNode, string?]> = [
    [t("detail.yesPool"), <span key={String(market.yesTotal)} className="tick num">{formatEthFixed(market.yesTotal)}</span>, "yes-text"],
    [t("detail.noPool"), <span key={String(market.noTotal)} className="tick num">{formatEthFixed(market.noTotal)}</span>, "no-text"],
    [t("detail.total"), `${formatEthFixed(market.total)} ETH`],
    [t("table.volume"), `${formatEthFixed(s.volume)} ETH`],
    [t("detail.addresses"), `${market.yesAccounts} / ${market.noAccounts}`],
  ];
  return (
    <section className="event-bar">
      <div className="event-bar-title">
        <MetricMark code={market.metric.code} />
        <div>
          <h1 className="detail-title" data-testid="market-question">
            {questionOf(market)}
          </h1>
          <div className="station-row">
            <span>
              <Icon name="pin" />
              {sourceOf(market)}
            </span>
            <PhaseBadge phase={phaseOf(market, now)} tag={marketTagOf(market)} />
            {isAdmin && (
              <a className="text-link" href={href.template(market.id)} data-testid="use-template">
                {t("new.useTemplate")}
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="event-price">
        {/* The share stays neutral: green and red mean Yes and No everywhere, so only the change badge is coloured. */}
        <strong className="price">
          {s.share === null ? (
            <Share value={null} />
          ) : (
            <>
              <Ticking value={s.share} text={s.share.toFixed(1)} decimals={1} />
              <small className="unit">%</small>
            </>
          )}
        </strong>
        <span>
          <small>{t("detail.yesShare")}</small> <InfoTip text={t("detail.yesShareTip")} /> <Change value={s.change} />
        </span>
      </div>
      <dl className="event-stats">
        {stats.map(([label, value, tone], i) => (
          <div key={i}>
            <dt>{label}</dt>
            <dd className={tone}>{value}</dd>
          </div>
        ))}
        <div>
          <CloseTime market={market} now={now} />
        </div>
      </dl>
    </section>
  );
}

type DetailTab = "trades" | "rules" | "doc";

function DetailTabs({ market, feed }: { market: MarketData; feed: AsyncState<ActivityItem[]> }) {
  const [tab, setTab] = useState<DetailTab>("trades");
  return (
    <section className="card detail-tabs">
      <div className="tabs card-tabs" role="tablist">
        {(["trades", "rules", "doc"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)} data-testid={`detail-tab-${k}`}>
            {t(`detail.tab.${k}` as MessageKey)}
          </button>
        ))}
      </div>
      {tab === "trades" && <ActivityFeed feed={feed} />}
      {tab === "rules" && <Rules market={market} />}
      {tab === "doc" && <RulesDocument market={market} />}
    </section>
  );
}

function Detail({ market }: { market: MarketData }) {
  const { now } = useApp();
  const book = useMarketBook(market);
  const feed: AsyncState<ActivityItem[]> = { ...book, data: book.data?.items };
  const bets = book.data?.items ?? [];
  return (
    <>
      <MarketNav market={market} view="detail" now={now} />
      <div className="detail-page" data-testid="pool-detail">
        <EventBar market={market} bets={bets} />
        <div className="trade-grid">
          <MarketList current={market.id} />
          <StakeChart bets={bets} state={book.data ? "ready" : book.error ? "error" : "loading"} />
          <PositionBook market={market} bets={bets} />
          <aside className="detail-aside">
            <BetPanel market={market} />
            {market.subject.kind === "HKO" && <HkoLivePanel />}
          </aside>
          <DetailTabs market={market} feed={feed} />
        </div>
      </div>
    </>
  );
}

export function MarketDetailPage({ id }: { id: number }) {
  return <MarketFrame id={id}>{(market) => <Detail market={market} />}</MarketFrame>;
}
