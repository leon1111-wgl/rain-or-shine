import type { ReactNode } from "react";
import { useAsync } from "../../hooks/useAsync";
import { t } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import type { ActivityItem } from "../../lib/activity";
import { stakeShare } from "../../lib/amount";
import { hkoLangOf, loadHkoLive } from "../../lib/hko";
import { type MarketData, phaseOf, shortLabelOf } from "../../lib/markets";
import { formatHktClock } from "../../lib/time";
import { MetricMark } from "../MetricMark";
import { Eth } from "../primitives";

const MIN_ITEMS = 10;

export function Marquee({ markets, items, now }: { markets: MarketData[]; items: ActivityItem[]; now: bigint }) {
  const { locale } = useI18n();
  const hko = useAsync(() => loadHkoLive(hkoLangOf(locale)), `hko|${locale}`, { identity: locale, pollMs: 5 * 60_000 });
  const byId = new Map(markets.map((m) => [m.id, m]));
  const entries: ReactNode[] = [];
  for (const m of markets.filter((x) => phaseOf(x, now) === "OPEN")) {
    entries.push(
      <span key={`m${m.id}`} className="mq-item">
        <MetricMark code={m.metric.code} small />
        <strong>{shortLabelOf(m)}</strong>
        <span>Yes {m.total === 0n ? "—" : `${stakeShare(m.yesTotal, m.total).toFixed(1)}%`}</span>
        <span className="muted">
          <Eth wei={m.total} unit />
        </span>
      </span>,
    );
  }
  for (const b of items.slice(-6).reverse()) {
    const m = byId.get(b.market);
    entries.push(
      <span key={`t${b.txHash}${b.logIndex}`} className="mq-item">
        <span className="mq-tag">{t("intro.marquee.trade")}</span>
        <span className="muted num">{formatHktClock(BigInt(b.timestamp))}</span>
        {m && <strong>{shortLabelOf(m)}</strong>}
        <span className={b.side === "YES" ? "yes-text" : "no-text"}>{b.side === "YES" ? "Yes" : "No"}</span>
        <Eth wei={b.amount} unit />
      </span>,
    );
  }
  const current = hko.data?.current.ok ? hko.data.current.value : null;
  if (current?.temperature) {
    entries.push(
      <span key="hko" className="mq-item">
        <span className="mq-tag hko">{t("intro.marquee.hko")}</span>
        <span>{t("intro.marquee.temp", { value: current.temperature.value })}</span>
        {current.humidity && <span>{t("intro.marquee.humidity", { value: current.humidity.value })}</span>}
      </span>,
    );
  }
  if (entries.length === 0) return null;
  const loop = Array.from({ length: Math.ceil(MIN_ITEMS / entries.length) }, (_, i) => entries.map((e, j) => <span key={`${i}-${j}`}>{e}</span>)).flat();
  return (
    <div className="marquee" aria-label={t("intro.marquee.label")} data-testid="marquee">
      <div className="marquee-track" style={{ animationDuration: `${loop.length * 5}s` }}>
        <div className="marquee-group">{loop}</div>
        <div className="marquee-group" aria-hidden="true" inert>
          {loop}
        </div>
      </div>
    </div>
  );
}
