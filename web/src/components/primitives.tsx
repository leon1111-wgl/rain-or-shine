import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNow } from "../hooks/useApp";
import type { DisplayPhase } from "../lib/phase";
import type { MarketTag } from "../lib/markets";
import { useMetricApp } from "../metric/context";
import { useToasts } from "../hooks/useToasts";
import { type MessageKey, type Params, t, tSegments } from "../i18n";
import { formatEth, formatEthFixed, stakeShare } from "../lib/amount";
import { explorerTx, shortHex } from "../lib/chain";
import { countdownTone, formatCountdown, formatMonthShort } from "../lib/time";
import { Icon, type IconName } from "./Icon";

const PHASE_TONE: Record<DisplayPhase, "" | "green" | "amber" | "terra"> = {
  SCHEDULED: "",
  OPEN: "green",
  WAITING_OBSERVATION: "",
  WAITING_DATA: "",
  AWAITING_PROPOSAL: "",
  PROPOSED: "",
  DISPUTED: "terra",
  SETTLEABLE: "",
  REJECTED: "terra",
  NO_PROPOSAL: "amber",
  REFUND_ELIGIBLE: "amber",
  REFUND: "amber",
  RESOLVED_YES: "green",
  RESOLVED_NO: "green",
};

const TAG_KEYS: Record<MarketTag, MessageKey> = { official: "market.officialTag", custom: "market.customTag", demo: "market.demoTag" };

export function PhaseBadge({ phase, tag }: { phase: DisplayPhase; tag?: MarketTag | null }) {
  return (
    <span className={`badge ${PHASE_TONE[phase]}`} data-testid="phase-badge" data-phase={phase}>
      <span className="dot" />
      {t(`phase.${phase}` as MessageKey)}
      {tag && <small className={`badge-tag badge-${tag}`} data-testid="market-tag" data-tag={tag}>{t(TAG_KEYS[tag])}</small>}
    </span>
  );
}

export function Eth({ wei, decimals = 3, unit }: { wei: bigint; decimals?: number; unit?: boolean }) {
  return (
    <span className="num eth" title={`${formatEth(wei, 18, 1)} ETH`}>
      {formatEthFixed(wei, decimals)}
      {unit && <small className="unit"> ETH</small>}
    </span>
  );
}

export function ShareBar({ yes, no }: { yes: bigint; no: bigint }) {
  return (
    <div className={`pool-bar ${yes + no === 0n ? "none" : ""}`} role="img" aria-label={t("bar.aria", { yes: formatEth(yes), no: formatEth(no) })}>
      <span style={{ width: `${stakeShare(yes, yes + no)}%` }} />
    </div>
  );
}

export function Share({ value }: { value: number | null }) {
  return <>{value === null ? "—" : `${value.toFixed(1)}%`}</>;
}

export function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="change">—</span>;
  const tone = value > 0 ? "up" : value < 0 ? "down" : "";
  return <span className={`change ${tone}`}>{`${value > 0 ? "+" : ""}${value.toFixed(1)}`}</span>;
}

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Ticking({ value, text, decimals = 3, from: start }: { value: number; text: string; decimals?: number; from?: number }) {
  const [shown, setShown] = useState<number | null>(null);
  const from = useRef(start ?? value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || reducedMotion()) return;
    const began = performance.now();
    let frame = requestAnimationFrame(function step(at: number) {
      const k = Math.min(1, (at - began) / 600);
      setShown(k < 1 ? start + (value - start) * (1 - (1 - k) ** 3) : null);
      if (k < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{shown === null ? text : shown.toFixed(decimals)}</>;
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={text} data-tip={text}>
      <Icon name="info" />
    </span>
  );
}

export function Skeleton({ rows = 3, testId }: { rows?: number; testId?: string }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={t("load.loading")} data-testid={testId}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

export function Countdown({ target }: { target: bigint }) {
  const now = useNow();
  return <span className={`countdown ${countdownTone(target - now)}`}>{formatCountdown(target - now)}</span>;
}

export function DateChip({ date }: { date: string }) {
  return (
    <span className="date-chip" aria-hidden="true">
      <strong>{Number(date.slice(6, 8))}</strong>
      <small>{formatMonthShort(date)}</small>
    </span>
  );
}

export function Callout({ children, tone, testId }: { children: ReactNode; tone?: "amber"; testId?: string }) {
  return (
    <div className={`callout ${tone ?? ""}`} data-testid={testId}>
      <Icon name="info" />
      <div>{children}</div>
    </div>
  );
}

export function Stat({ icon, value, note }: { icon: IconName; value: ReactNode; note: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-icon">
        <Icon name={icon} />
      </div>
      <div>
        <strong>{value}</strong>
        <small>{note}</small>
      </div>
    </div>
  );
}

export function PageHeading({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {sub && <p className="subtext">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="callout amber" role="alert" data-testid="load-error">
      <Icon name="info" />
      <div>
        {t("load.error", { error })}{" "}
        <button type="button" className="text-button" onClick={retry}>
          {t("load.retry")}
        </button>
      </div>
    </div>
  );
}

export function Msg({ k, params }: { k: MessageKey; params: Params }) {
  return (
    <>
      {tSegments(k, params).map((s, i) =>
        s.param ? (
          <span key={i} className="nowrap">
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

export function CopyButton({ text }: { text: string }) {
  const toasts = useToasts();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show(t("toast.copied"), "ok");
    } catch {
      toasts.show(t("toast.copyFailed"), "bad");
    }
  };
  return (
    <button type="button" className="copy" onClick={() => void copy()} aria-label={t("copy.label")} title={t("copy.label")} data-testid="copy">
      <Icon name="copy" />
    </button>
  );
}

export function ShortHash({ value, testId }: { value: string; testId?: string }) {
  return (
    <span className="short-hash" data-testid={testId}>
      <span className="mono" title={value}>
        {shortHex(value)}
      </span>
      <CopyButton text={value} />
    </span>
  );
}

export function TxLink({ hash, full }: { hash: string; full?: boolean }) {
  const { dep } = useMetricApp();
  const link = explorerTx(dep, hash);
  const text = full ? hash : shortHex(hash);
  return (
    <>
      {link ? (
        <a className="mono" href={link} target="_blank" rel="noreferrer" title={hash}>
          {text}
        </a>
      ) : (
        <span className="mono" title={hash}>
          {text}
        </span>
      )}
      {full && <CopyButton text={hash} />}
    </>
  );
}
