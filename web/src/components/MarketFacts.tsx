import { t } from "../i18n";
import type { MarketData } from "../lib/markets";
import { formatHktMinute } from "../lib/time";
import { Countdown } from "./primitives";

export function CloseTime({ market, now }: { market: MarketData; now: bigint }) {
  const tm = market.times;
  if (now < tm.openAt) {
    return (
      <span className="close-time">
        <small>{t("table.opensIn")}</small>
        <Countdown target={tm.openAt} />
      </span>
    );
  }
  if (now < tm.closeAt) {
    return (
      <span className="close-time">
        <small>{t("table.closesIn")}</small>
        <Countdown target={tm.closeAt} />
      </span>
    );
  }
  return (
    <span className="close-time">
      <small>{t("table.closed")}</small>
      <span>{formatHktMinute(tm.closeAt)}</span>
    </span>
  );
}
