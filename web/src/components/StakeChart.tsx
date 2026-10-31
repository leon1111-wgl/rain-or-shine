// The market's chart in bet order: the Yes share after each bet (from the totals replayed up to it), or both sides'
// cumulative stakes. Hovering shows the figures after a bet. Amounts stay integer wei. Only the drawing scale is a
// fraction.

import { useId, useState, type MouseEvent } from "react";
import { t } from "../i18n";
import type { ActivityItem } from "../lib/activity";
import { formatEth, formatEthFixed } from "../lib/amount";
import { shareAfter } from "../lib/market";
import { formatHktShort } from "../lib/time";
import { InfoTip } from "./primitives";

const W = 600;
const H = 220;

type Mode = "share" | "stakes";

interface Point {
  yes: bigint;
  no: bigint;
  share: number;
  at: number;
}

function pointsOf(bets: ActivityItem[]): Point[] {
  return bets.map((b) => ({ yes: b.yesTotal, no: b.noTotal, share: shareAfter(b), at: b.timestamp }));
}

/** Bet i (1-based) holds its value from x = (i-1)/n to i/n of the width. */
export function stepLine(ys: number[], width = W): string {
  const n = ys.length;
  let d = `M0 ${ys[0]}`;
  ys.forEach((y, i) => {
    d += `V${y}H${((i + 1) / n) * width}`;
  });
  return d;
}

/** The plot sits between 6 % and 94 % of the height, so no line touches an axis label. */
const plotY = (fraction: number) => H * 0.94 - fraction * H * 0.88;
const SHARE_TICKS = [0, 25, 50, 75, 100];

function maxStake(points: Point[]): bigint {
  return points.reduce((m, p) => (p.yes > m ? p.yes : p.no > m ? p.no : m), 0n);
}

function Plot({ id, points, mode }: { id: string; points: Point[]; mode: Mode }) {
  const max = maxStake(points);
  const shareY = (v: number) => plotY(v / 100);
  const stakeY = (v: bigint) => plotY(max === 0n ? 0 : Number((v * 10_000n) / max) / 10_000);
  const lines: Array<["yes" | "no", string]> =
    mode === "share"
      ? [["yes", stepLine(points.map((p) => shareY(p.share)))]]
      : [
          ["no", stepLine(points.map((p) => stakeY(p.no)))],
          ["yes", stepLine(points.map((p) => stakeY(p.yes)))],
        ];
  const grid = mode === "share" ? SHARE_TICKS.map((v) => shareY(v)) : [0, 0.5, 1].map(plotY);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        {(["yes", "no"] as const).map((tone) => (
          <linearGradient key={tone} id={`${id}-${tone}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={`stop-${tone}`} stopOpacity="0.28" />
            <stop offset="1" className={`stop-${tone}`} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {grid.map((y) => (
        <line key={y} className="grid" x1="0" x2={W} y1={y} y2={y} />
      ))}
      {mode === "share" && <line className="ref" x1="0" x2={W} y1={shareY(50)} y2={shareY(50)} />}
      {lines.map(([tone, d]) => (
        <path key={`${tone}-fill`} d={`${d}V${plotY(0)}H0Z`} fill={`url(#${id}-${tone})`} />
      ))}
      {lines.map(([tone, d]) => (
        <path key={tone} d={d} className={`line ${tone}`} />
      ))}
    </svg>
  );
}

/** The y labels at the gridlines: 0–100 % for the share, 0 to the largest side for the stakes. */
function Axis({ points, mode }: { points: Point[]; mode: Mode }) {
  const max = maxStake(points);
  const marks: Array<[number, string]> =
    mode === "share" ? SHARE_TICKS.map((v) => [plotY(v / 100), `${v}%`]) : [0n, max / 2n, max].map((v, i) => [plotY(i / 2), formatEthFixed(v)]);
  return (
    <>
      {marks.map(([y, label]) => (
        <span key={label + y} className="axis-y" style={{ top: `${(y / H) * 100}%` }}>
          {label}
        </span>
      ))}
    </>
  );
}

function Tip({ point, index, n, mode }: { point: Point; index: number; n: number; mode: Mode }) {
  const x = ((index - 0.5) / n) * 100;
  return (
    <>
      <span className="chart-cursor" style={{ left: `${x}%` }} />
      <div className={`chart-tip ${x < 25 ? "start" : x > 75 ? "end" : ""}`} style={{ left: `${x}%` }}>
        <small>
          {t("chart.after", { n: index })} <time>{formatHktShort(BigInt(point.at))}</time>
        </small>
        {mode === "share" ? (
          <span className="yes-text">Yes {point.share.toFixed(1)}%</span>
        ) : (
          <>
            <span className="yes-text">Yes {formatEthFixed(point.yes)} ETH</span>
            <span className="no-text">No {formatEthFixed(point.no)} ETH</span>
          </>
        )}
      </div>
    </>
  );
}

export function StakeChart({ bets, state }: { bets: ActivityItem[]; state: "loading" | "error" | "ready" }) {
  const id = useId().replace(/[^\w-]/g, "");
  const [mode, setMode] = useState<Mode>("share");
  const [hover, setHover] = useState<number | null>(null);
  const points = pointsOf(bets);
  const n = points.length;
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(n, Math.max(1, Math.floor(((e.clientX - box.left) / box.width) * n) + 1)));
  };
  const shown = hover === null ? undefined : points[hover - 1];
  const last = points[n - 1];
  return (
    <section className="card chart-card" aria-label={t("chart.title")} data-testid="stake-chart">
      <div className="panel-heading">
        <div className="tabs card-tabs" role="tablist" aria-label={t("chart.title")}>
          {(["share", "stakes"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={`tab ${mode === m ? "active" : ""}`} onClick={() => setMode(m)} data-testid={`chart-${m}`}>
              {t(`chart.${m}`)}
            </button>
          ))}
        </div>
        <div className="legend">
          {mode === "stakes" && (
            <span className="no-text">
              <i className="swatch no" /> No
            </span>
          )}
          <span className="yes-text">
            <i className="swatch yes" /> Yes
          </span>
          <InfoTip text={t("chart.note")} />
        </div>
      </div>
      <div className="chart" onMouseMove={n > 0 ? pick : undefined} onMouseLeave={() => setHover(null)} role="img" aria-label={last ? t("chart.aria", { yes: formatEth(last.yes), no: formatEth(last.no), n }) : t("chart.empty")}>
        {n > 0 && <Plot id={id} points={points} mode={mode} />}
        {n > 0 && <Axis points={points} mode={mode} />}
        {n === 0 && <p className="chart-empty">{state === "error" ? t("chart.error") : state === "ready" ? t("chart.empty") : t("chart.loading")}</p>}
        {shown && hover !== null && <Tip point={shown} index={hover} n={n} mode={mode} />}
      </div>
      {n > 0 && (
        <div className="axis-x">
          <span>{formatHktShort(BigInt(points[0]!.at))}</span>
          {n > 2 && <span>{formatHktShort(BigInt(points[Math.floor((n - 1) / 2)]!.at))}</span>}
          <span>{formatHktShort(BigInt(last!.at))}</span>
        </div>
      )}
    </section>
  );
}
