// The market's positions laid out like an order book: No stakes above, Yes stakes below, largest next to the Yes
// share in the middle, each with a depth bar. Next to it, the latest trades. Both come from the verified bet history.

import { useState } from "react";
import { useWallet } from "../hooks/useWallet";
import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEthFixed, stakeShare } from "../lib/amount";
import { shortHex } from "../lib/chain";
import { type Position, positionsOf, shareAfter } from "../lib/market";
import type { MarketData } from "../lib/markets";
import { formatHktClock } from "../lib/time";
import { Share } from "./primitives";

const ROWS = 7;
const percent = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 1_000n) / whole) / 10);

function Side({ list, side, total, max, me }: { list: Position[]; side: "yes" | "no"; total: bigint; max: bigint; me: string | undefined }) {
  return (
    <ol className={`book-side ${side}`}>
      {list.map((p) => (
        <li key={p.account} className={p.account.toLowerCase() === me ? "mine" : ""} title={p.account}>
          <span className="depth" style={{ width: `${percent(p.stake, max)}%` }} />
          <span className="mono">{shortHex(p.account)}</span>
          <span className="num">{formatEthFixed(p.stake)}</span>
          <span className="num">{percent(p.stake, total).toFixed(1)}%</span>
        </li>
      ))}
    </ol>
  );
}

function Book({ market, bets }: { market: MarketData; bets: ActivityItem[] }) {
  const wallet = useWallet();
  const { yes, no } = positionsOf(bets);
  const max = [...yes, ...no].reduce((m, p) => (p.stake > m ? p.stake : m), 0n);
  const last = bets[bets.length - 1];
  const before = bets[bets.length - 2];
  const trend = last && before ? (shareAfter(last) > shareAfter(before) ? "up" : shareAfter(last) < shareAfter(before) ? "down" : "") : "";
  const me = wallet.account?.toLowerCase();
  return (
    <div className="book" data-testid="position-book">
      <div className="book-head">
        <span>{t("book.address")}</span>
        <span>{t("book.stake")}</span>
        <span>{t("book.share")}</span>
      </div>
      <Side list={no.slice(0, ROWS).reverse()} side="no" total={market.noTotal} max={max} me={me} />
      <div className={`book-mid ${trend}`}>
        <strong>
          <Share value={market.total === 0n ? null : stakeShare(market.yesTotal, market.total)} />
        </strong>
        <span>{t("book.mid")}</span>
      </div>
      <Side list={yes.slice(0, ROWS)} side="yes" total={market.yesTotal} max={max} me={me} />
    </div>
  );
}

function Tape({ bets }: { bets: ActivityItem[] }) {
  return (
    <ol className="tape" data-testid="trade-tape">
      <li className="tape-head">
        <span>{t("tape.time")}</span>
        <span>{t("tape.side")}</span>
        <span>{t("tape.amount")}</span>
      </li>
      {bets
        .slice(-18)
        .reverse()
        .map((b) => (
          <li key={`${b.txHash}:${b.logIndex}`} title={b.account}>
            <span className="muted num">{formatHktClock(BigInt(b.timestamp), true)}</span>
            <span className={b.side === "YES" ? "yes-text" : "no-text"}>{b.side === "YES" ? "Yes" : "No"}</span>
            <span className="num">{formatEthFixed(b.amount)}</span>
          </li>
        ))}
    </ol>
  );
}

export function PositionBook({ market, bets }: { market: MarketData; bets: ActivityItem[] }) {
  const [tab, setTab] = useState<"book" | "tape">("book");
  return (
    <section className="card book-card" aria-label={t("book.title")}>
      <div className="tabs card-tabs" role="tablist">
        {(["book", "tape"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)} data-testid={`book-tab-${k}`}>
            {k === "book" ? t("book.title") : t("tape.title")}
          </button>
        ))}
      </div>
      {bets.length === 0 ? <p className="chart-empty-box">{t("chart.empty")}</p> : tab === "book" ? <Book market={market} bets={bets} /> : <Tape bets={bets} />}
    </section>
  );
}
