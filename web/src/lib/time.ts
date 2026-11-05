// Time display with explicit zones. Markets are defined in Asia/Hong_Kong; UTC is shown alongside.
// Nothing depends on the viewer's browser timezone.

import { activeLocale, t } from "../i18n";

const fmt = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
const HKT = fmt("Asia/Hong_Kong");
const UTC = fmt("UTC");

function render(formatter: Intl.DateTimeFormat, unix: bigint): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(Number(unix) * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export const formatUtc = (unix: bigint) => `${render(UTC, unix)} UTC`;

export function formatHktMinuteBare(unix: bigint): string {
  return render(HKT, unix).slice(0, 16);
}

export function formatHktMinute(unix: bigint): string {
  return `${render(HKT, unix).slice(0, 16)} HKT`;
}

export function formatHktShort(unix: bigint): string {
  const parts = Object.fromEntries(HKT.formatToParts(new Date(Number(unix) * 1000)).map((p) => [p.type, p.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute} HKT`;
}

export function formatHktClock(unix: bigint, withSeconds = false): string {
  return render(HKT, unix).slice(11, withSeconds ? 19 : 16);
}

export function formatHktStamp(unix: bigint, reference: bigint): string {
  const [day, ref] = [render(HKT, unix), render(HKT, reference)];
  return day.slice(0, 10) === ref.slice(0, 10) ? day.slice(11, 16) : `${day.slice(5, 10)} ${day.slice(11, 16)}`;
}

export function formatLocalDate(yyyymmdd: bigint | number | string): string {
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function formatMonthShort(yyyymmdd: string): string {
  const s = String(yyyymmdd);
  return new Intl.DateTimeFormat(activeLocale(), { month: "short", timeZone: "UTC" }).format(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, 1));
}

export function formatCountdown(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  const pad = (n: bigint) => String(n).padStart(2, "0");
  const clock = `${pad((s % 86_400n) / 3_600n)}:${pad((s % 3_600n) / 60n)}:${pad(s % 60n)}`;
  return s >= 86_400n ? t("time.days", { d: s / 86_400n, clock }) : clock;
}

export function formatDuration(seconds: bigint): string {
  let s = seconds < 0n ? 0n : seconds;
  const d = s / 86_400n;
  s %= 86_400n;
  const h = s / 3_600n;
  s %= 3_600n;
  const m = s / 60n;
  s %= 60n;
  if (d > 0n) return h > 0n ? t("time.dh", { d, h }) : t("time.d", { d });
  if (h > 0n) return m > 0n ? t("time.hm", { h, m }) : t("time.h", { h });
  if (m > 0n) return s > 0n ? t("time.ms", { m, s }) : t("time.m", { m });
  return t("time.s", { s });
}

export function relative(target: bigint, now: bigint): string {
  return target >= now ? t("time.in", { duration: formatDuration(target - now) }) : t("time.ago", { duration: formatDuration(now - target) });
}

export function countdownTone(seconds: bigint): "" | "soon" | "urgent" {
  if (seconds < 600n) return "urgent";
  if (seconds < 3_600n) return "soon";
  return "";
}
