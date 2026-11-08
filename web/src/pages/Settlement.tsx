import { Callout, InfoTip, Msg, PageHeading, PhaseBadge, TxLink } from "../components/primitives";
import { Icon } from "../components/Icon";
import { MarketFrame } from "../components/MarketFrame";
import { MarketNav } from "../components/MarketNav";
import { TxStatus } from "../components/TxStatus";
import { useApp } from "../hooks/useApp";
import { useAsync } from "../hooks/useAsync";
import { useTransaction } from "../hooks/useTransaction";
import { useWallet } from "../hooks/useWallet";
import { type MessageKey, t } from "../i18n";
import { formatEth, formatEthSigned } from "../lib/amount";
import { type MarketData, formatReading, marketTagOf, phaseOf, questionOf, unitOf } from "../lib/markets";
import type { DisplayPhase } from "../lib/phase";
import { type ClaimRecord, loadClaims } from "../lib/records";
import { href } from "../lib/routes";
import { formatHktMinute } from "../lib/time";
import { marketOf } from "../metric/client";

const FINAL: DisplayPhase[] = ["RESOLVED_YES", "RESOLVED_NO", "REFUND", "REFUND_ELIGIBLE"];

function outcomeText(market: MarketData, phase: DisplayPhase) {
  const final = FINAL.includes(phase);
  const isRefund = phase === "REFUND" || phase === "REFUND_ELIGIBLE";
  const a = market.assertion;
  const reading = a ? (a.kind === "TRACE" ? t("result.trace") : `${formatReading(a.value, market.metric)} ${unitOf(market.metric.unit)}`) : null;
  // A rejected assertion refunds at once. It uses the timeout's reason code. The assertion record tells the two apart.
  const refundKey = market.refundReason === "NO_VALID_SETTLEMENT" && a?.rejected ? "REJECTED" : market.refundReason;
  const title = !final ? t("settle.notFinal") : isRefund ? t(`settle.refund.${refundKey}` as MessageKey) : t(phase === "RESOLVED_YES" ? "settle.yesWon" : "settle.noWon");
  const basis = isRefund ? t(`reason.${refundKey}` as MessageKey) : reading ? t(market.subject.kind === "CUSTOM" ? "settle.basisCustom" : market.subject.kind === "SYNTHETIC" ? "settle.basisDemo" : "settle.basis", { reading, outcome: phase === "RESOLVED_YES" ? "Yes" : "No" }) : "—";
  return { final, isRefund, title, basis };
}

function Settlement({ market }: { market: MarketData }) {
  const api = useApp();
  const wallet = useWallet();
  const tx = useTransaction();
  const phase = phaseOf(market, api.now);
  const account = wallet.account;
  const known = Boolean(account && api.data);
  const claims = useAsync(async () => (account ? loadClaims(api.dep, api.reader, account) : null), `${api.dep.chainId}|${account}|${market.position.claimed}`, {
    enabled: Boolean(account),
    identity: `${api.dep.chainId}|${account ?? ""}`,
  });
  const { final, isRefund, title, basis } = outcomeText(market, phase);
  const claimRecord = claims.data?.get(market.id);
  const claim = () => void tx.run(isRefund ? t("settle.refundLabel") : t("settle.claimLabel"), (signer) => marketOf(api.dep, signer).claim(market.id));
  return (
    <>
      <MarketNav market={market} view="settlement" now={api.now} />
      <PageHeading title={t("settle.heading")} />
      <section className="card" data-testid="settlement">
        <div className="result-top">
          <div>
            <PhaseBadge phase={phase} tag={marketTagOf(market)} />
            <h2 className="result-title" data-testid="result-title">
              {title}
            </h2>
            <p className="subtext">{questionOf(market)}</p>
          </div>
          <div className={`result-icon ${isRefund ? "refund" : ""}`}>
            <Icon name={isRefund ? "refund" : "check"} />
          </div>
        </div>
        {!final && (
          <Callout>
            {t("settle.waitFirst")} <a href={href.market(market.id, "waiting")}>{t("view.waiting")}</a>
          </Callout>
        )}
        <div className="info-grid">
          <div className="info-item">
            <span>{t("settle.basisLabel")}</span>
            <strong data-testid="basis">{basis}</strong>
          </div>
          <div className="info-item">
            <span>{t("settle.myPosition")}</span>
            <strong>{!account ? t("wait.noWallet") : !known ? "—" : market.position.side ? `${market.position.side} ${formatEth(market.position.stake)} ETH` : t("wait.notJoined")}</strong>
          </div>
          <div className="info-item">
            <span>{t("settle.poolTotal")}</span>
            <strong>
              {formatEth(market.total)} ETH {known && market.position.stake > 0n && <small>{market.position.claimed ? t("settle.claimed") : t("settle.unclaimed")}</small>}
            </strong>
          </div>
        </div>
        <MoneyTiles market={market} claim={claimRecord ?? null} connected={known} final={final} isRefund={isRefund} />
        <div className="claim-row">
          <p>
            {isRefund ? t("settle.refundRule") : t("settle.payoutRule")} <InfoTip text={t("settle.onceRule")} />
          </p>
          {known && market.claimable > 0n ? (
            <button type="button" className="primary accent" onClick={claim} disabled={tx.busy || !wallet.isCorrectChain} data-testid="claim">
              {isRefund ? t("settle.refundButton") : t("settle.claimButton")}
            </button>
          ) : (
            <button type="button" className="secondary" disabled data-testid="claim-disabled">
              {market.position.claimed ? t("settle.claimed") : t("settle.nothing")}
            </button>
          )}
        </div>
        <TxStatus state={tx.state} />
        {claimRecord && (
          <p className="fine-print" data-testid="claim-receipt">
            <Msg k="settle.receipt" params={{ amount: formatEth(claimRecord.amount, 18) }} /> <TxLink hash={claimRecord.txHash} full />
          </p>
        )}
        {final && !isRefund && market.position.side && market.position.side !== (phase === "RESOLVED_YES" ? "YES" : "NO") && <Callout>{t("settle.loser")}</Callout>}
      </section>
      <MarketOverview market={market} />
    </>
  );
}

function MoneyTiles({ market, claim, connected, final, isRefund }: { market: MarketData; claim: ClaimRecord | null; connected: boolean; final: boolean; isRefund: boolean }) {
  const stake = market.position.stake;
  const due = market.position.claimed ? (claim?.amount ?? null) : market.claimable;
  const money = (wei: bigint | null) => (connected && wei !== null ? formatEth(wei) : "—");
  return (
    <div className="money-grid">
      <div className="money-tile">
        <span className="label">{t("settle.stake")}</span>
        <div>
          <strong data-testid="money-stake">{money(stake)}</strong>
          <small> ETH</small>
        </div>
      </div>
      <div className="money-tile highlight">
        <span className="label">
          {market.position.claimed ? t("settle.alreadyClaimed") : isRefund ? t("settle.refundable") : t("settle.payable")} <InfoTip text={isRefund ? t("settle.whyRefund") : t("settle.whyPayout")} />
        </span>
        <div>
          <strong data-testid="money-due">{money(due)}</strong>
          <small> ETH</small>
        </div>
      </div>
      <div className="money-tile">
        <span className="label">{t("settle.net")}</span>
        <div>
          <strong className={due !== null && due - stake >= 0n ? "yes-text" : "no-text"} data-testid="money-net">
            {final && connected && due !== null && stake > 0n ? formatEthSigned(due - stake) : "—"}
          </strong>
          <small> ETH</small>
        </div>
      </div>
    </div>
  );
}

function MarketOverview({ market }: { market: MarketData }) {
  return (
    <section className="card subsection">
      <h3>{t("settle.overview")}</h3>
      <dl className="review-list">
        <dt>Yes</dt>
        <dd>
          {formatEth(market.yesTotal)} ETH <small>{t("settle.addresses", { n: market.yesAccounts })}</small>
        </dd>
        <dt>No</dt>
        <dd>
          {formatEth(market.noTotal)} ETH <small>{t("settle.addresses", { n: market.noAccounts })}</small>
        </dd>
        <dt>{t("settle.paid")}</dt>
        <dd>{formatEth(market.paidOut, 18)} ETH</dd>
        <dt>{t("settle.boundary")}</dt>
        <dd>{formatHktMinute(market.times.refundAt)}</dd>
      </dl>
    </section>
  );
}

export function SettlementPage({ id }: { id: number }) {
  return <MarketFrame id={id}>{(market) => <Settlement market={market} />}</MarketFrame>;
}
