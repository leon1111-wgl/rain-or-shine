// The metric registry as a table. A new metric is registered by the new-market flow, together with its first market.

import { formatFixed100 } from "@shared/metric/fixed100";
import { isOfficialMetric, isSportsMetric } from "@shared/metric/numeric-profiles";
import { type MessageKey, t } from "../i18n";
import { useMetricApp } from "./context";

const TAGS: Record<"official" | "demo" | "custom", MessageKey> = { official: "market.officialTag", demo: "market.demoTag", custom: "market.customTag" };
const tagOf = (metric: { code: string; rulesHash: string }) => (isOfficialMetric(metric) ? "official" : isSportsMetric(metric) ? "demo" : "custom");

export function Registry() {
  const api = useMetricApp();
  const metrics = api.data?.metrics ?? [];
  return <section className="card ops-section" aria-labelledby="registry-title" data-testid="registry">
    <div className="panel-heading"><h2 id="registry-title">{t("registry.title")}</h2><span className="tag">{t("registry.count", { n: metrics.length })}</span></div>
    <p className="subtext">{t("registry.sub")}</p>
    {metrics.length > 0 && <div className="table-scroll"><table className="plain-table">
      <thead><tr><th>{t("registry.id")}</th><th>{t("registry.metric")}</th><th>{t("registry.range")}</th><th>{t("registry.step")}</th></tr></thead>
      <tbody>{[...metrics].sort((a, b) => Number(isOfficialMetric(b)) - Number(isOfficialMetric(a))).map((metric) => <tr key={metric.id} data-testid={`metric-row-${metric.code}`}>
        <td>{metric.id}</td><td>{metric.code} <small className={`badge-tag badge-${tagOf(metric)}`}>{t(TAGS[tagOf(metric)])}</small></td>
        <td>{t("registry.rangeValue", { min: formatFixed100(metric.minValue), max: formatFixed100(metric.maxValue), unit: metric.unit })}</td>
        <td>{formatFixed100(metric.valueStep)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
