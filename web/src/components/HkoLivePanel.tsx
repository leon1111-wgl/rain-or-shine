import { currentWeatherPageUrl, type Reading } from "@shared/weather/live";
import { useAsync } from "../hooks/useAsync";
import { activeLocale, t } from "../i18n";
import { type HkoLive, hkoLangOf, loadHkoLive } from "../lib/hko";
import { formatHktClock, formatHktStamp, formatLocalDate } from "../lib/time";
import { InfoTip, Skeleton } from "./primitives";

const POLL_MS = 60_000;
const STALE_AFTER_S = 3 * 3_600;
const UNITS: Record<string, string> = { C: "°C", percent: "%" };

interface Shown {
  value: string;
  note: string;
  title?: string;
}

function Tile({ label, testId, shown }: { label: string; testId: string; shown: Shown }) {
  return (
    <div className="hko-tile" data-testid={testId} title={shown.title}>
      <dt>{label}</dt>
      <dd>
        <strong key={shown.value}>{shown.value}</strong>
        <small>{shown.note}</small>
      </dd>
    </div>
  );
}

function Readings({ data }: { data: HkoLive }) {
  const readAt = BigInt(data.readAt);
  const stamp = (at: number) => formatHktStamp(BigInt(at), readAt);
  const failed = (error: string): Shown => ({ value: "—", note: t("hko.failed"), title: error });
  const notProvided: Shown = { value: "—", note: t("hko.notProvided") };
  const reading = (r: Reading | null): Shown => (r ? { value: `${r.value} ${UNITS[r.unit] ?? r.unit}`, note: stamp(r.at) } : notProvided);
  const { current, hourly, yesterday } = data;

  const temperature = current.ok ? reading(current.value.temperature) : failed(current.error);
  const humidity = current.ok ? reading(current.value.humidity) : failed(current.error);
  const hour: Shown = !hourly.ok
    ? failed(hourly.error)
    : hourly.value === null
      ? notProvided
      : { value: hourly.value.mm === null ? t("hko.maintenance") : `${hourly.value.mm} mm`, note: t("hko.until", { time: stamp(hourly.value.until) }) };
  const day: Shown = !yesterday.ok
    ? { value: "—", note: yesterday.error.startsWith("DATA_UNAVAILABLE") ? t("hko.notPublished") : t("hko.failed"), title: yesterday.error }
    : {
        value: yesterday.value.rainfall.kind === "TRACE" ? t("hko.trace") : `${yesterday.value.rainfall.text} mm`,
        note: t("hko.wholeDay", { date: formatLocalDate(yesterday.value.date).slice(5) }),
      };
  const stale = current.ok && data.readAt - current.value.updatedAt > STALE_AFTER_S;

  return (
    <>
      <dl className="hko-grid">
        <Tile label={t("hko.temperature")} testId="hko-temperature" shown={temperature} />
        <Tile label={t("hko.humidity")} testId="hko-humidity" shown={humidity} />
        <Tile label={t("hko.hourRain")} testId="hko-hour" shown={hour} />
        <Tile label={t("hko.yesterday")} testId="hko-yesterday" shown={day} />
      </dl>
      {current.ok && current.value.warnings.length > 0 && (
        <p className="hko-warning" data-testid="hko-warning" title={current.value.warnings.join("\n")}>
          {current.value.warnings[0]}
        </p>
      )}
      <p className={`hko-foot ${stale ? "stale" : ""}`} data-testid="hko-times">
        {current.ok && <span className="nowrap">{t("hko.updated", { time: stamp(current.value.updatedAt) })}</span>}
        <span className="nowrap">{t("hko.readAt", { time: formatHktClock(readAt, true) })}</span>
      </p>
      {stale && <p className="hko-foot stale">{t("hko.stale")}</p>}
    </>
  );
}

export function HkoLivePanel() {
  const lang = hkoLangOf(activeLocale());
  const live = useAsync(() => loadHkoLive(lang), `hko|${lang}`, { pollMs: POLL_MS, identity: lang });
  return (
    <section className="hko-live" aria-labelledby="hko-live-title" data-testid="hko-live">
      <header>
        <h3 id="hko-live-title">
          <span className="live-dot" aria-hidden="true" />
          {t("hko.title")} <InfoTip text={t("hko.note")} />
        </h3>
        <a href={currentWeatherPageUrl(lang)} target="_blank" rel="noreferrer">
          {t("hko.check")}
        </a>
      </header>
      {live.error && (
        <p className="hko-error" role="alert" data-testid="hko-error">
          {t("hko.error", { error: live.error })}{" "}
          <button type="button" className="text-button" onClick={live.reload}>
            {t("load.retry")}
          </button>
        </p>
      )}
      {live.loading && !live.data && <Skeleton rows={2} />}
      {live.data && <Readings data={live.data} />}
    </section>
  );
}
