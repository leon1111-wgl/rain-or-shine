// View 5: the connected account's participation: its positions and claimable amounts from the dashboard, its bets
// from the verified bet history and its claims from the Claimed logs. Switching account or chain changes the read
// identity, so the previous account's rows disappear immediately.

import { LoadError, Msg, PageHeading, PhaseBadge, Skeleton, Stat, TxLink } from "../components/primitives";
import { useApp } from "../hooks/useApp";
import { useAsync } from "../hooks/useAsync";
import { useActivity, useMarkets } from "../hooks/useMarkets";
import { useWallet } from "../hooks/useWallet";
import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEth } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { localizeChainMessage } from "../lib/chainErrors";
import { type MarketData, phaseOf, shortLabelOf, sourceOf } from "../lib/markets";
import { viewOf } from "../lib/phase";
import { type ClaimRecord, loadClaims } from "../lib/records";
import { href } from "../lib/routes";

export function MyParticipationPage() {
  const api = useApp();
  const wallet = useWallet();
  const account = wallet.account;
  const markets = useMarkets();
  const mine = (account && api.data ? (markets.data ?? []) : []).filter((m) => m.position.stake > 0n);
  const activity = useActivity(account ? mine : undefined);
  const claims = useAsync(async () => (account ? loadClaims(api.dep, api.reader, account) : null), `${api.dep.chainId}|${account}|${mine.filter((m) => m.position.claimed).length}`, {
    enabled: Boolean(account),
    identity: `${api.dep.chainId}|${account ?? ""}`,
  });

  if (!account) {
    return (
      <>
        <PageHeading title={t("mine.title")} sub={t("mine.subNoWallet")} />
        <div className="empty" data-testid="mine-no-wallet">
          <p>{t("mine.connectFirst")}</p>
          {wallet.status === "unavailable" ? (
            <a className="primary accent" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              {t("wallet.install")}
            </a>
          ) : (
            <button type="button" className="primary accent" onClick={() => void wallet.connect()}>
              {t("wallet.connect")}
            </button>
          )}
        </div>
      </>
    );
  }
  const me = account.toLowerCase();
  const betsOf = (m: MarketData) => (activity.data ?? []).filter((b) => b.market === m.id && b.account.toLowerCase() === me);
  const invested = mine.reduce((n, m) => n + m.position.stake, 0n);
  const claimable = mine.reduce((n, m) => n + m.claimable, 0n);
  return (
    <>
      <PageHeading title={t("mine.title")} sub={t("mine.sub", { account: shortHex(account) })} />
      <div className="stat-grid">
        <Stat icon="layers" value={t("mine.events", { n: mine.length })} note={t("mine.eventsNote")} />
        <Stat icon="shield" value={`${formatEth(invested)} ETH`} note={t("mine.invested")} />
        <Stat icon="refund" value={`${formatEth(claimable)} ETH`} note={t("mine.claimable")} />
      </div>
      {markets.error && <LoadError error={localizeChainMessage(markets.error)} retry={() => void api.refresh(true)} />}
      {!api.data && <Skeleton rows={4} testId="mine-loading" />}
      {api.data && mine.length === 0 && (
        <div className="empty" data-testid="mine-empty">
          {t("mine.empty")} <a href={href.list}>{t("nav.list")}</a>
        </div>
      )}
      {mine.length > 0 && (
        <section className="card table-card">
          <div className="table-scroll">
            <table className="records" data-testid="records">
              <thead>
                <tr>
                  <th>{t("mine.col.event")}</th>
                  <th>{t("mine.col.side")}</th>
                  <th>{t("mine.col.bets")}</th>
                  <th>{t("mine.col.status")}</th>
                  <th>{t("mine.col.claim")}</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((m) => (
                  <RecordRow key={m.id} market={m} bets={betsOf(m)} claim={claims.data?.get(m.id) ?? null} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** One market: the locked side and stake, every bet with its transaction, the phase, and the claim receipt or next step. */
function RecordRow({ market, bets, claim }: { market: MarketData; bets: ActivityItem[]; claim: ClaimRecord | null }) {
  const { now } = useApp();
  const phase = phaseOf(market, now);
  return (
    <tr data-testid="record-row" data-market={market.id}>
      <td>
        <strong>{shortLabelOf(market)}</strong>
        <small>{sourceOf(market)}</small>
      </td>
      <td>
        <span className={market.position.side === "YES" ? "yes-text" : "no-text"}>{t("mine.locked", { side: market.position.side ?? "—" })}</span>
        <br />
        <span className="num">{formatEth(market.position.stake)} ETH</span>
      </td>
      <td>
        <ul className="bet-list">
          {bets.map((b) => (
            <li key={`${b.txHash}:${b.logIndex}`}>
              <span className="num">+{formatEth(b.amount)}</span> {b.side} <TxLink hash={b.txHash} />
            </li>
          ))}
        </ul>
      </td>
      <td>
        <PhaseBadge phase={phase} />
      </td>
      <td>
        {claim ? (
          <>
            <strong>
              <Msg k="mine.claimed" params={{ amount: formatEth(claim.amount) }} />
            </strong>
            <small>
              <TxLink hash={claim.txHash} />
            </small>
          </>
        ) : (
          <a className="text-button" href={href.market(market.id, viewOf(phase))}>
            {market.claimable > 0n ? <Msg k="mine.toClaim" params={{ amount: formatEth(market.claimable) }} /> : t("mine.view")}
          </a>
        )}
      </td>
    </tr>
  );
}
