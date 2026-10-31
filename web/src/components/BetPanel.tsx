// Bet panel of the detail view. The side lock, minimum and window are enforced by the contract. The panel explains
// them first: the opposite side of a locked position is disabled with its reason, and nothing is shown as done before
// a successful receipt. The bet goes through the numeric client's runner, which re-verifies the deployment and the
// account before signing.

import type { JsonRpcSigner } from "ethers";
import { type CSSProperties, useState } from "react";
import { useApp } from "../hooks/useApp";
import { useAsync } from "../hooks/useAsync";
import { useTransaction } from "../hooks/useTransaction";
import { useWallet } from "../hooks/useWallet";
import { t } from "../i18n";
import { MIN_BET_WEI, formatEth, parseBetAmount } from "../lib/amount";
import { CHAIN_NAMES } from "../lib/chain";
import { localizeChainMessage } from "../lib/chainErrors";
import { type MarketData, type Side, phaseOf, questionOf } from "../lib/markets";
import { href } from "../lib/routes";
import { formatHktMinute } from "../lib/time";
import { errorMessage, marketOf } from "../metric/client";
import { payoutIfWins } from "@shared/metric/payout";
import { InfoTip } from "./primitives";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { TxStatus } from "./TxStatus";

const CODE: Record<Side, 1 | 2> = { YES: 1, NO: 2 };

interface Review {
  side: Side;
  value: bigint;
  gasCost: bigint;
  balance: bigint;
}

type Action = { label: string; run?: () => void; disabled?: boolean };
/** A confirmed bet. */
type Done = { side: Side; amount: bigint };
const METAMASK_URL = "https://metamask.io/download/";

/** What the main button does now: open, wallet, network, proposer, side and amount checks in that order. */
function actionOf(o: { isOpen: boolean; notYetOpen: boolean; openAt: bigint; walletMissing: boolean; account: string | null; correctChain: boolean; chain: string | number; isProposer: boolean; side: Side | null; locked: boolean; ready: boolean; connect: () => void; switchChain: () => void; prepare: () => void }): Action {
  if (!o.isOpen) return { label: o.notYetOpen ? t("bet.notOpen", { time: formatHktMinute(o.openAt) }) : t("bet.closed"), disabled: true };
  if (o.walletMissing) return { label: t("wallet.none"), disabled: true };
  if (!o.account) return { label: t("wallet.connect"), run: o.connect };
  if (!o.correctChain) return { label: t("wallet.switch", { chain: o.chain }), run: o.switchChain };
  if (o.isProposer) return { label: t("bet.proposerBlocked"), disabled: true };
  if (!o.side) return { label: t("bet.pickSide"), disabled: true };
  return { label: o.locked ? t("bet.topUp") : t("bet.review"), run: o.prepare, disabled: !o.ready };
}

export function BetPanel({ market }: { market: MarketData }) {
  const api = useApp();
  const wallet = useWallet();
  const tx = useTransaction();
  const [picked, setPicked] = useState<Side | null>(null);
  const [amountText, setAmountText] = useState("0.010");
  const [review, setReview] = useState<Review | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const account = wallet.account;
  // The dashboard reads the connected account's position. Without an account there is none to show.
  const known = Boolean(account && api.data);
  const locked = known ? market.position.side : null;
  const side = locked ?? picked;
  const amount = parseBetAmount(amountText);
  const isOpen = phaseOf(market, api.now) === "OPEN";
  // The contract refuses bets from the market's proposer (ProposerCannotBet). Say so before a wallet prompt.
  const isProposer = account !== null && account.toLowerCase() === market.proposer.toLowerCase();
  const balance = useAsync(async () => (account ? api.reader.getBalance(account) : null), `${api.dep.chainId}|${account}|${wallet.epoch}|${api.data?.blockNumber ?? 0}`, {
    enabled: Boolean(account),
    identity: account ?? "",
  });

  async function prepare() {
    if (!side || !amount.ok || !account) return;
    setPrepError(null);
    try {
      const signer = await wallet.getSigner();
      const [funds, gas, fees] = await Promise.all([
        api.reader.getBalance(account),
        marketOf(api.dep, signer).bet.estimateGas(market.id, CODE[side], { value: amount.value }),
        api.reader.getFeeData(),
      ]);
      const gasCost = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
      if (funds < amount.value + gasCost) {
        setPrepError(t("bet.insufficient", { balance: formatEth(funds), need: formatEth(amount.value + gasCost, 6) }));
        return;
      }
      setReview({ side, value: amount.value, gasCost, balance: funds });
    } catch (err) {
      setPrepError(localizeChainMessage(errorMessage(err)));
    }
  }

  async function confirm() {
    const r = review;
    setReview(null);
    if (!r) return;
    const ok = await tx.run(t("bet.txLabel", { side: r.side, amount: formatEth(r.value) }), (signer: JsonRpcSigner) => marketOf(api.dep, signer).bet(market.id, CODE[r.side], { value: r.value }));
    if (ok) setDone({ side: r.side, amount: r.value });
  }

  const action = actionOf({
    isOpen,
    notYetOpen: api.now < market.times.openAt,
    openAt: market.times.openAt,
    walletMissing: wallet.status === "unavailable",
    account,
    correctChain: wallet.isCorrectChain,
    chain: CHAIN_NAMES[api.dep.chainId] ?? api.dep.chainId,
    isProposer,
    side,
    locked: locked !== null,
    ready: amount.ok && !tx.busy && known,
    connect: () => void wallet.connect(),
    switchChain: () => void wallet.switchChain(),
    prepare: () => void prepare(),
  });

  return (
    <section className="card bet-card" aria-labelledby="bet-title" data-testid="bet-panel">
      <h2 id="bet-title" className="sr-only">
        {t("bet.title")}
      </h2>
      <SideChoice side={side} locked={locked} isOpen={isOpen} onPick={setPicked} />
      <AmountField text={amountText} onChange={setAmountText} amount={amount} locked={locked !== null} balance={balance.data ?? null} />
      <StakeSummary market={market} side={side} locked={locked} stake={known ? market.position.stake : null} add={amount.ok ? amount.value : null} />
      <button type="button" className={`primary full ${side && isOpen ? `side-${side.toLowerCase()}` : ""}`} onClick={action.run} disabled={action.disabled ?? false} data-testid="bet-submit">
        {action.label}
      </button>
      {isOpen && isProposer && (
        <p className="fine-print" data-testid="bet-proposer">
          {t("bet.proposerNote")}
        </p>
      )}
      {prepError && (
        <p className="input-note error" role="alert" data-testid="bet-error">
          {prepError}
        </p>
      )}
      {wallet.status === "unavailable" && (
        <p className="fine-print">
          <a href={METAMASK_URL} target="_blank" rel="noreferrer">
            {t("wallet.install")}
          </a>
        </p>
      )}
      <TxStatus state={tx.state} />
      {done && <BetDone done={done} market={market} onAgain={() => setDone(null)} />}
      {!isOpen && api.now >= market.times.closeAt && (
        <p className="fine-print">
          <a href={href.market(market.id, "waiting")}>{t("bet.toWaiting")}</a>
        </p>
      )}
      {review && <BetReview review={review} market={market} chainId={api.dep.chainId} onClose={() => setReview(null)} onConfirm={() => void confirm()} />}
    </section>
  );
}

/** The position right after a confirmed bet, as the contract now reports it. Then the next step. */
function BetDone({ done, market, onAgain }: { done: Done; market: MarketData; onAgain: () => void }) {
  return (
    <div className="bet-done" role="status" data-testid="bet-done">
      <strong>
        <Icon name="check" />
        {t("bet.done", { side: done.side, amount: formatEth(done.amount) })}
      </strong>
      <div className="summary-row">
        <span>{t("bet.position")}</span>
        <strong data-testid="done-position">
          {market.position.side ?? done.side} <span className="num">{formatEth(market.position.stake)} ETH</span>
        </strong>
      </div>
      <div className="bet-done-actions">
        <button type="button" className="secondary" onClick={onAgain} data-testid="bet-again">
          {t("bet.again")}
        </button>
        <a className="primary" href={href.market(market.id, "waiting")} data-testid="bet-progress">
          {t("bet.progress")}
        </a>
      </div>
    </div>
  );
}

/** Yes/No choice. Once a side is locked on-chain the other button is disabled and says why. */
function SideChoice({ side, locked, isOpen, onPick }: { side: Side | null; locked: Side | null; isOpen: boolean; onPick: (s: Side) => void }) {
  return (
    <>
      <div className="choices" role="group" aria-label={t("bet.side")}>
        {(["YES", "NO"] as const).map((s) => {
          const blocked = locked !== null && locked !== s;
          return (
            <button
              key={s}
              type="button"
              className={`choice ${s.toLowerCase()} ${side === s ? "selected" : ""}`}
              aria-pressed={side === s}
              disabled={blocked || !isOpen}
              title={blocked ? t("bet.lockedTitle", { side: locked }) : undefined}
              onClick={() => onPick(s)}
              data-testid={`side-${s}`}
            >
              <strong>{s === "YES" ? "Yes" : "No"}</strong>
              <small>{s === "YES" ? t("bet.yesHint") : t("bet.noHint")}</small>
            </button>
          );
        })}
      </div>
      <div className={`side-lock-row ${locked ? "locked" : ""}`}>
        <Icon name="lock" />
        <p className="side-lock" data-testid="side-lock">
          {locked ? t("bet.locked", { side: locked }) : t("bet.unlocked")}
        </p>
        <InfoTip text={t("bet.lockRule")} />
      </div>
    </>
  );
}

const MARKS = [0, 25, 50, 75, 100];

/** Decimal ETH text in, exact wei out (parseBetAmount). Invalid input explains itself and blocks submit. With a
 *  known balance, a slider sets the amount as a share of it (rounded down to 0.000001 ETH). */
function AmountField({ text, onChange, amount, locked, balance }: { text: string; onChange: (v: string) => void; amount: ReturnType<typeof parseBetAmount>; locked: boolean; balance: bigint | null }) {
  const percent = balance && amount.ok ? Math.min(100, Number((amount.value * 100n) / balance)) : 0;
  const setPercent = (p: number) => {
    if (balance !== null) onChange(formatEth((balance * BigInt(p)) / 100n, 6));
  };
  return (
    <>
      <div className="field-row">
        <label className="field-label" htmlFor="amount">
          {locked ? t("bet.amountTopUp") : t("bet.amount")}
        </label>
        <span className="available" data-testid="available">
          {t("bet.available")} <strong>{balance === null ? "—" : formatEth(balance, 4)}</strong> ETH
        </span>
      </div>
      <div className="amount-field">
        <input id="amount" inputMode="decimal" autoComplete="off" value={text} onChange={(e) => onChange(e.target.value)} aria-describedby="amount-note" aria-invalid={!amount.ok} data-testid="amount" />
        <span>{t("bet.unit")}</span>
      </div>
      <div className="slider">
        <input type="range" min={0} max={100} step={1} value={percent} disabled={balance === null} onChange={(e) => setPercent(Number(e.target.value))} aria-label={t("bet.percent")} style={{ "--fill": `${percent}%` } as CSSProperties} />
        <div className="marks">
          {MARKS.map((m) => (
            <button key={m} type="button" disabled={balance === null} className={percent >= m ? "on" : ""} onClick={() => setPercent(m)}>
              {m}%
            </button>
          ))}
        </div>
      </div>
      <p className={`input-note ${amount.ok ? "" : "error"}`} id="amount-note" data-testid="amount-note">
        {amount.ok ? t("bet.note", { min: formatEth(MIN_BET_WEI) }) : amount.error}
      </p>
    </>
  );
}

/** Current stake on each side and the stake after this amount; `stake` is null until a connected account's
 *  position has been read: unknown is shown as "—", never as 0. */
const SIDE_LABEL: Record<Side, string> = { YES: "Yes", NO: "No" };
type Estimate = { refund: true; other: Side } | { refund: false; wei: bigint };

/** What a side would pay: the contract's own formula (src/metric/payout) on the current totals plus this bet, or the
 * refund rule while nobody is on the other side. */
function estimateOf(market: MarketData, side: Side, stake: bigint, add: bigint): Estimate {
  const other: Side = side === "YES" ? "NO" : "YES";
  if ((other === "YES" ? market.yesTotal : market.noTotal) === 0n) return { refund: true, other };
  return { refund: false, wei: payoutIfWins({ yesTotal: market.yesTotal, noTotal: market.noTotal, side, stake, add }) };
}

function PayoutRow({ market, side, stake, add }: { market: MarketData; side: Side; stake: bigint; add: bigint }) {
  const e = estimateOf(market, side, stake, add);
  if (e.refund) {
    return (
      <p className="fine-print payout-refund" data-testid="payout-estimate">
        {t("bet.payoutRefund", { other: SIDE_LABEL[e.other] })}
      </p>
    );
  }
  return (
    <div className="summary-row">
      <span>
        {t("bet.payoutIf", { side: SIDE_LABEL[side] })} <InfoTip text={t("bet.payoutTip")} />
      </span>
      <strong data-testid="payout-estimate">{stake + add > 0n ? `${formatEth(e.wei)} ETH` : "—"}</strong>
    </div>
  );
}

function StakeSummary({ market, side, locked, stake, add }: { market: MarketData; side: Side | null; locked: Side | null; stake: bigint | null; add: bigint | null }) {
  const own = (s: Side) => (stake === null ? "—" : `${formatEth(locked === s ? stake : 0n)} ETH`);
  return (
    <div className="summary">
      <div className="summary-row">
        <span>{t("bet.haveYes")}</span>
        <strong data-testid="have-yes">{own("YES")}</strong>
      </div>
      <div className="summary-row">
        <span>{t("bet.haveNo")}</span>
        <strong data-testid="have-no">{own("NO")}</strong>
      </div>
      <div className="summary-row">
        <span>{t("bet.after")}</span>
        <strong data-testid="stake-after">{stake !== null && add !== null ? `${formatEth(stake + add)} ETH` : "—"}</strong>
      </div>
      {side && <PayoutRow market={market} side={side} stake={locked === side && stake !== null ? stake : 0n} add={add ?? 0n} />}
      <div className="summary-row">
        <span>
          {t("bet.fee")} <InfoTip text={t("bet.gasNote")} />
        </span>
        <strong>0 ETH</strong>
      </div>
    </div>
  );
}

/** Everything the wallet will be asked to sign, in exact wei, before it is asked. */
function BetReview({ review, market, chainId, onClose, onConfirm }: { review: Review; market: MarketData; chainId: number; onClose: () => void; onConfirm: () => void }) {
  const estimate = estimateOf(market, review.side, market.position.side === review.side ? market.position.stake : 0n, review.value);
  return (
    <Dialog
      title={t("bet.reviewTitle")}
      onClose={onClose}
      testId="bet-review"
      actions={
        <button type="button" className="primary" onClick={onConfirm} data-testid="bet-confirm">
          {t("bet.sign")}
        </button>
      }
    >
      <dl className="review-list">
        <dt>{t("review.network")}</dt>
        <dd>
          {CHAIN_NAMES[chainId] ?? chainId} ({chainId})
        </dd>
        <dt>{t("review.market")}</dt>
        <dd>
          #{market.id} {questionOf(market)}
        </dd>
        <dt>{t("review.side")}</dt>
        <dd>{review.side}</dd>
        <dt>{t("review.value")}</dt>
        <dd>
          {formatEth(review.value, 18)} ETH <span className="muted">({review.value.toString()} wei)</span>
        </dd>
        <dt>{t("bet.payoutIf", { side: SIDE_LABEL[review.side] })}</dt>
        <dd data-testid="review-payout">
          {estimate.refund ? t("bet.payoutRefund", { other: SIDE_LABEL[estimate.other] }) : `${formatEth(estimate.wei)} ETH`}
        </dd>
        <dt>{t("review.fee")}</dt>
        <dd data-testid="review-fee">{t("review.feeNone")}</dd>
        <dt>{t("review.gas")}</dt>
        <dd>≤ {formatEth(review.gasCost, 8)} ETH</dd>
        <dt>{t("review.balance")}</dt>
        <dd>{formatEth(review.balance, 6)} ETH</dd>
      </dl>
      <p className="fine-print">
        {estimate.refund ? "" : `${t("review.payoutNote")} `}
        {t("bet.reviewNote")}
      </p>
    </Dialog>
  );
}
