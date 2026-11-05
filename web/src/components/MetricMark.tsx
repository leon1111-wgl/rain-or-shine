import { metricKindOf, metricNameOf, type MetricKind } from "../lib/markets";
import { Icon, type IconName } from "./Icon";

const ICONS: Record<MetricKind, IconName> = { rain: "rain", heat: "thermo", humidity: "humidity", custom: "layers", sport: "ball" };
const CODE_ICONS: Record<string, IconName> = { DAILY_MEAN_PRESSURE: "gauge", DAILY_MEAN_CLOUD: "cloud" };

export function MetricMark({ code, small }: { code: string; small?: boolean }) {
  const kind = metricKindOf(code);
  return (
    <span className={`metric-mark ${small ? "small" : ""}`} data-metric={kind} title={metricNameOf(code)} aria-hidden="true">
      <Icon name={CODE_ICONS[code] ?? ICONS[kind]} />
    </span>
  );
}
