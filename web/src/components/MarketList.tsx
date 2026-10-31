// The events beside the trading screen, as on an exchange's trade page: each one's Yes share and 24 h change,
// Observatory events first, the one on screen marked.

import { useMemo } from "react";
import { useNow } from "../hooks/useApp";
import { useActivity, useMarkets } from "../hooks/useMarkets";
import { t } from "../i18n";
import { marketStats } from "../lib/market";
import { conditionOf, metricShortOf, phaseOf, windowOf } from "../lib/markets";
import { viewOf } from "../lib/phase";
import { href } from "../lib/routes";
import { Change, Share } from "./primitives";
import { MetricMark } from "./MetricMark";

export function MarketList({ current }: { current: number }) {
  const now = useNow();
  const markets = useMarkets();
  const activity = useActivity(markets.data);
  const rows = useMemo(() => markets.data ?? [], [markets.data]);
  return (
    <aside className="card market-list" aria-label={t("list.events")}>
      <h2 className="card-label">{t("list.events")}</h2>
      <ol>
        {rows.map((m) => {
          const s = marketStats(m, activity.data ?? [], Number(now));
          return (
            <li key={m.id} className={m.id === current ? "active" : ""}>
              <a href={href.market(m.id, viewOf(phaseOf(m, now)))}>
                <MetricMark code={m.metric.code} small />
                <span className="list-name">
                  <strong>{windowOf(m)}</strong>
                  <small>
                    {metricShortOf(m.metric.code)} {conditionOf(m)}
                  </small>
                </span>
                <span className="list-figures">
                  <span className="num">
                    <Share value={s.share} />
                  </span>
                  <Change value={s.change} />
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
