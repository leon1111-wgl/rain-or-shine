// View 3: waiting for the result. Progress comes from chain time and records only. The user cannot switch states.
// Once UMA's challenge period is over anyone may settle. When the refund is effective, the settlement view acts.

import { formatUnits } from "ethers";
import type { ReactNode } from "react";
import { ClientStatus } from "../components/ClientStatus";
import { Callout, Countdown, InfoTip, Msg, PageHeading, PhaseBadge, ShortHash, TxLink } from "../components/primitives";
import { MarketFrame } from "../components/MarketFrame";
import { MarketNav } from "../components/MarketNav";
import { useApp } from "../hooks/useApp";
import { useAsync } from "../hooks/useAsync";
import { useWallet } from "../hooks/useWallet";
import { type MessageKey, t } from "../i18n";
import { formatEth } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { localizeChainMessage } from "../lib/chainErrors";
import { type MarketData, formatReading, hkoFieldMarketOf, isLocalMock, marketTagOf, phaseOf, questionOf, sourceOf, unitOf } from "../lib/markets";
import { waitingStep } from "../lib/phase";
import { type EvidenceRecord, loadEvidence } from "../lib/records";
import { href } from "../lib/routes";
import { formatDuration, formatHktMinute, formatUtc } from "../lib/time";
import { OracleActions } from "../metric/OracleActions";

function Waiting({ market }: { market: MarketData }) {
  const api = useApp();
  const wallet = useWallet();
  const phase = phaseOf(market, api.now);
  const a = market.assertion;
  const evidence = useAsync(() => loadEvidence(api.dep, api.reader, market), `${api.dep.chainId}|${market.id}|${a?.id ?? ""}`, { enabled: Boolean(a), identity: `${market.id}|${a?.id ?? ""}` });
  const reading = a ? (a.kind === "TRACE" ? t("result.trace") : `${formatReading(a.value, market.metric)} ${unitOf(market.metric.unit)}`) : null;
  const known = Boolean(wallet.account && api.data);
  const isProposer = wallet.account?.toLowerCase() === market.proposer.toLowerCase();
  const challenge = market.uma && !market.uma.settled && !a?.disputed && api.now < market.uma.expirationTime;

  return (
    <>
      <MarketNav market={market} view="waiting" now={api.now} />
      <PageHeading title={t("wait.title")} />
      <section className="card" data-testid="waiting">
        <div className="waiting-top">
          <div>
            <PhaseBadge phase={phase} tag={marketTagOf(market)} />
            <h2 className="result-title">{questionOf(market)}</h2>
            <p className="subtext" data-testid="phase-explain">
              {/* Settle first: past refundAt an undisputed result still decides the market once someone settles it. */}
              {t(phase === "SETTLEABLE" && api.now >= market.times.refundAt ? "explain.SETTLEABLE_LATE" : (`explain.${phase}` as MessageKey), { time: formatHktMinute(market.times.refundAt) })}
            </p>
          </div>
          {challenge && market.uma && (
            <div className="waiting-clock" data-testid="liveness">
              <small>{t("wait.challengeLeft")}</small>
              <Countdown target={market.uma.expirationTime} />
            </div>
          )}
        </div>
        <Timeline market={market} step={waitingStep(phase)} />
        <div className="info-grid">
          <div className="info-item">
            <span>{t("wait.source")}</span>
            <strong>{sourceOf(market)}</strong>
          </div>
          <div className="info-item" data-testid="assertion-info">
            <span>
              {t("wait.claim")} {!isLocalMock(api.dep) && <InfoTip text={t("wait.noDvm")} />}
            </span>
            <strong>
              {a ? t("wait.claimValue", { id: shortHex(a.id), reading: reading ?? "" }) : t("wait.noClaim")}
              {a?.disputed && <span className="no-text"> {t("wait.disputed")}</span>}
              {a?.rejected && <span className="no-text"> {t("wait.rejected")}</span>}
            </strong>
          </div>
          <div className="info-item">
            <span>{t("wait.mine")}</span>
            <strong>{!wallet.account ? t("wait.noWallet") : !known ? "—" : market.position.side ? `${market.position.side} ${formatEth(market.position.stake)} ETH` : t("wait.notJoined")}</strong>
          </div>
        </div>
        {evidence.error && <p className="input-note error">{localizeChainMessage(evidence.error)}</p>}
        {evidence.data && <EvidenceDetails evidence={evidence.data} hko={market.subject.kind === "HKO"} bondDecimals={api.dep.oracle.bondDecimals} bondSymbol={api.dep.oracle.bondSymbol} />}
        <Callout testId="late-data">
          {t(market.subject.kind === "HKO" || hkoFieldMarketOf(market) ? "wait.lateHko" : "wait.lateCustom", { cutoff: formatHktMinute(market.times.proposalCutoff), refundAt: formatHktMinute(market.times.refundAt) })}
        </Callout>
        <Callout tone="amber">{t("wait.boundaryRule")}</Callout>
        <div className="simple-row actions">
          {phase === "AWAITING_PROPOSAL" && isProposer && (
            <a className="primary accent" href={href.ops(market.id)} data-testid="to-propose">
              {t("wait.toPropose")}
            </a>
          )}
          {(phase === "REFUND_ELIGIBLE" || phase === "RESOLVED_YES" || phase === "RESOLVED_NO" || phase === "REFUND") && (
            <a className="primary" href={href.market(market.id, "settlement")}>
              {t("wait.toSettlement")}
            </a>
          )}
        </div>
      </section>
      <OracleActions market={market.view} part="oracle" />
      <ClientStatus />
    </>
  );
}

/** The five fixed steps with the market's own on-chain times; `step` comes from the phase mapping. */
function Timeline({ market, step }: { market: MarketData; step: number }) {
  const tm = market.times;
  const steps: Array<[string, ReactNode]> = [
    [t("wait.step.close"), <span className="nowrap">{formatHktMinute(tm.closeAt)}</span>],
    [t("wait.step.observed"), <span className="nowrap">{formatHktMinute(tm.observationEnd)}</span>],
    [t("wait.step.data"), <Msg k="wait.step.dataTime" params={{ time: formatHktMinute(tm.earliestAssertionAt) }} />],
    [t("wait.step.challenge"), market.uma ? <Msg k="wait.step.until" params={{ time: formatHktMinute(market.uma.expirationTime) }} /> : <Msg k="wait.step.liveness" params={{ duration: formatDuration(tm.assertionLiveness) }} />],
    [t("wait.step.final"), <Msg k="wait.step.boundary" params={{ time: formatHktMinute(tm.refundAt) }} />],
  ];
  return (
    <ol className="timeline" aria-label={t("wait.progress")}>
      {steps.map(([label, time], i) => (
        <li key={label} className={`step ${i < step ? "done" : i === step ? "current" : ""}`} aria-current={i === step ? "step" : undefined}>
          <strong>{label}</strong>
          <small>{time}</small>
        </li>
      ))}
    </ol>
  );
}

/** What the proposer put on-chain: source, raw-byte hash, capture time, excerpt and bond. */
function EvidenceDetails({ evidence, hko, bondDecimals, bondSymbol }: { evidence: EvidenceRecord; hko: boolean; bondDecimals: number; bondSymbol: string }) {
  return (
    <details className="evidence" data-testid="evidence">
      <summary>{t("wait.evidence")}</summary>
      <dl className="review-list">
        <dt>{t("evidence.source")}</dt>
        <dd className="mono">{evidence.sourceUrl}</dd>
        <dt>
          {/* An official HKO market's source is the Observatory's file. A custom market's is the document its rules name. */}
          {t("fingerprint.data")} <InfoTip text={t(hko ? "fingerprint.dataTip" : "fingerprint.dataTipSource")} />
        </dt>
        <dd>
          <ShortHash value={evidence.rawSha256} testId="data-fingerprint" />
        </dd>
        <dt>{t("evidence.captured")}</dt>
        <dd>{formatUtc(evidence.capturedAt)}</dd>
        <dt>{t("evidence.excerpt")}</dt>
        <dd className="mono">{evidence.excerpt}</dd>
        <dt>{t("evidence.bond")}</dt>
        <dd>
          {formatUnits(evidence.bond, bondDecimals)} {bondSymbol}
        </dd>
        <dt>{t("evidence.tx")}</dt>
        <dd>
          <TxLink hash={evidence.txHash} full />
        </dd>
      </dl>
    </details>
  );
}

export function WaitingPage({ id }: { id: number }) {
  return <MarketFrame id={id}>{(market) => <Waiting market={market} />}</MarketFrame>;
}
