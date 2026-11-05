import { useId } from "react";
import { t } from "../i18n";

const TOP = 6;
const SPAN = 88;
const levelY = (share: number) => TOP + (1 - share / 100) * SPAN;

export function Gauge({ share, height = 120 }: { share: number | null; height?: number }) {
  const id = useId().replace(/[^\w-]/g, "");
  return (
    <svg className="gauge" viewBox="0 0 40 100" style={{ height, width: height * 0.4 }} role="img" aria-label={share === null ? t("chart.empty") : t("gauge.aria", { share: share.toFixed(1) })}>
      <defs>
        <clipPath id={`${id}-tube`}>
          <rect x="9" y="4" width="22" height="92" rx="11" />
        </clipPath>
        <linearGradient id={`${id}-water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7cc4ff" />
          <stop offset="1" stopColor="#2f73ff" />
        </linearGradient>
      </defs>
      <rect x="9" y="4" width="22" height="92" rx="11" className="gauge-tube" />
      <g clipPath={`url(#${id}-tube)`}>
        <g className="gauge-level" style={{ transform: `translateY(${levelY(share ?? 0)}px)` }}>
          <path className="gauge-wave" d="M-40 0q5-3 10 0t10 0t10 0t10 0t10 0t10 0t10 0t10 0V100H-40z" fill={`url(#${id}-water)`} />
        </g>
      </g>
      {[25, 50, 75].map((m) => (
        <line key={m} className="gauge-tick" x1={m === 50 ? 1 : 4} x2="8" y1={levelY(m)} y2={levelY(m)} />
      ))}
    </svg>
  );
}
