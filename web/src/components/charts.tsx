// Small SVG charts for the markets, data and detail views. Plot values are fractions for drawing only. Every
// value a reader sees comes preformatted from integer amounts (`label`, `title`).

import { useId, useState, type MouseEvent, type ReactNode } from "react";

const W = 600;
const H = 200;

const useSvgId = () => useId().replace(/[^\w-]/g, "");

/** Fraction of the sparkline height for `v` between `min` and `max`, with headroom at the top. */
const level = (v: number, min: number, max: number) => (max === min ? 0.5 : ((v - min) / (max - min)) * 0.88);

/** Yes share after each bet as a tiny line: green when it ended at or above where it started, red below. */
export function Sparkline({ values }: { values: number[] }) {
  const id = useSvgId();
  if (values.length < 2) return <span className="spark none" aria-hidden="true" />;
  const min = Math.min(...values, 50);
  const max = Math.max(...values, 50);
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(30 - level(v, min, max) * 28 - 1).toFixed(2)}`);
  const tone = values[values.length - 1]! >= values[0]! ? "up" : "down";
  return (
    <svg className={`spark ${tone}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="stop" stopOpacity="0.28" />
          <stop offset="1" className="stop" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M${points.join("L")}V30H0Z`} fill={`url(#${id}-f)`} />
      <path d={`M${points.join("L")}`} className="spark-line" />
    </svg>
  );
}

export interface ChartPoint {
  x: number;
  y: number;
  /** What the tooltip says for this point (exact, preformatted). */
  label: ReactNode;
}

/**
 * One series as a step line with an optional fill, a crosshair and a tooltip. `domain` fixes the y range (a share
 * is always 0–100 %). Otherwise it runs from 0 to the largest value. Gridlines sit at the labelled `ticks`;
 * `reference` draws a dashed level (50 % for a share).
 */
export function TimeChart({ points, tone, axis, reference, xLabel, area = true, domain, ticks }: { points: ChartPoint[]; tone: "yes" | "no" | "neutral"; axis: (y: number) => string; reference?: number; xLabel: (x: number) => string; area?: boolean; domain?: [number, number]; ticks?: number[] }) {
  const id = useSvgId();
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <div className="chart chart-empty-box" />;
  const xs = points.map((p) => p.x);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const top = Math.max(...points.map((p) => p.y), reference ?? 0);
  const [y0, y1] = domain ?? [0, top === 0 ? 1 : top];
  const marks = ticks ?? [y0, (y0 + y1) / 2, y1];
  const px = (x: number) => (x1 === x0 ? W : ((x - x0) / (x1 - x0)) * W);
  // Plot between 6 % and 94 % of the height so the line never touches a label.
  const py = (y: number) => H * 0.94 - ((y - y0) / (y1 - y0 || 1)) * H * 0.88;
  let d = `M0 ${py(points[0]!.y)}`;
  for (const p of points) d += `H${px(p.x)}V${py(p.y)}`;
  d += `H${W}`;
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = x0 + ((e.clientX - box.left) / box.width) * (x1 - x0);
    let i = 0;
    while (i + 1 < points.length && points[i + 1]!.x <= x) i++;
    setHover(i);
  };
  const shown = hover === null ? undefined : points[hover];
  const left = shown ? (px(shown.x) / W) * 100 : 0;
  return (
    <div className="chart-box">
      <div className="chart" onMouseMove={pick} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className={`stop-${tone}`} stopOpacity="0.3" />
              <stop offset="1" className={`stop-${tone}`} stopOpacity="0" />
            </linearGradient>
          </defs>
          {marks.map((m) => (
            <line key={m} className="grid" x1="0" x2={W} y1={py(m)} y2={py(m)} />
          ))}
          {reference !== undefined && <line className="ref" x1="0" x2={W} y1={py(reference)} y2={py(reference)} />}
          {area && <path d={`${d}V${py(y0)}H0Z`} fill={`url(#${id}-f)`} />}
          <path d={d} className={`line ${tone}`} />
          {shown && <circle className={`dot ${tone}`} cx={px(shown.x)} cy={py(shown.y)} r="3.5" />}
        </svg>
        {marks.map((m) => (
          <span key={m} className="axis-y" style={{ top: `${(py(m) / H) * 100}%` }}>
            {axis(m)}
          </span>
        ))}
        {shown && (
          <>
            <span className="chart-cursor" style={{ left: `${left}%` }} />
            <div className={`chart-tip ${left < 25 ? "start" : left > 75 ? "end" : ""}`} style={{ left: `${left}%` }}>
              <small>{xLabel(shown.x)}</small>
              {shown.label}
            </div>
          </>
        )}
      </div>
      <div className="axis-x">
        <span>{xLabel(x0)}</span>
        {x1 > x0 && <span>{xLabel(Math.round((x0 + x1) / 2))}</span>}
        <span>{xLabel(x1)}</span>
      </div>
    </div>
  );
}

export interface Bar {
  key: string;
  label: string;
  /** Stacked parts, bottom first. Drawing values only. */
  parts: Array<{ value: number; tone: "yes" | "no" | "neutral" }>;
  title: ReactNode;
}

/** Stacked vertical bars on a labelled scale (`axis` formats the top and middle), with the hovered bar's title. */
export function BarChart({ bars, axis }: { bars: Bar[]; axis?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...bars.map((b) => b.parts.reduce((n, p) => n + p.value, 0)));
  const shown = hover === null ? undefined : bars[hover];
  return (
    <div className="bar-chart" onMouseLeave={() => setHover(null)}>
      <div className="bar-plot">
        {axis && max > 0 && (
          <>
            <span className="axis-y bar-axis" style={{ top: "0%" }}>
              {axis(max)}
            </span>
            <span className="axis-y bar-axis" style={{ top: "50%" }}>
              {axis(max / 2)}
            </span>
          </>
        )}
        <ol className="bars">
          {bars.map((b, i) => {
            const sum = b.parts.reduce((n, p) => n + p.value, 0);
            return (
              <li key={b.key} className={`${hover === i ? "active" : ""} ${sum === 0 ? "zero" : ""}`} onMouseEnter={() => setHover(i)}>
                <span className="bar" style={{ height: `${max === 0 ? 0 : (sum / max) * 100}%` }}>
                  {b.parts.map((p, j) => (
                    <span key={j} className={`bar-part ${p.tone}`} style={{ height: `${sum === 0 ? 0 : (p.value / sum) * 100}%` }} />
                  ))}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="bar-labels">
        {bars.map((b, i) => (
          <span key={b.key}>{i % Math.ceil(bars.length / 7) === 0 ? b.label : ""}</span>
        ))}
      </div>
      {shown && (
        <div className={`chart-tip ${hover! < bars.length / 4 ? "start" : hover! > (bars.length * 3) / 4 ? "end" : ""}`} style={{ left: `${((hover! + 0.5) / bars.length) * 100}%` }}>
          <small>{shown.label}</small>
          {shown.title}
        </div>
      )}
    </div>
  );
}
