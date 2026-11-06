// The page's own server relays them byte for byte (launcher/hko-relay.mjs). Some system proxies break a direct connection to HKO.
// A static host has no relay. There the page reads data.weather.gov.hk directly. That host allows cross-origin reads.

import {
  type CurrentWeather,
  type DailyRain,
  type HkoLang,
  type HourlyRain,
  currentWeatherUrl,
  hourlyRainfallUrl,
  parseCurrentWeather,
  parseDailyRainfall,
  parseHourlyRainfall,
  previousHkDate,
} from "@shared/weather/live";
import { HKO_OPEN_DATA_ORIGIN, ryesUrl } from "@shared/weather/profile";
import { parseJsonStrict } from "@shared/weather/strict";
import { HKO_RELAY_PREFIX } from "../../../launcher/hko-relay.mjs";
import type { Locale } from "../i18n";

export type Part<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HkoLive {
  readAt: number;
  current: Part<CurrentWeather>;
  hourly: Part<HourlyRain | null>;
  yesterday: Part<DailyRain>;
}

export const HKO_UNREACHABLE = "HKO_UNREACHABLE";

const TIMEOUT_MS = 12_000;
const published = new Map<string, DailyRain>();

export function clearHkoCache(): void {
  published.clear();
}

export const hkoLangOf = (locale: Locale): HkoLang => (locale === "en" ? "en" : "sc");

export function viaPageServer(official: string): string {
  const url = new URL(official);
  return `${HKO_RELAY_PREFIX}${url.pathname}${url.search}`;
}

const request = async (url: string, fetchImpl: typeof fetch) => {
  try {
    return await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails. The timeout signal rejects with a TimeoutError.
    if (err instanceof TypeError || (err as { name?: string } | null)?.name === "TimeoutError") throw new Error(HKO_UNREACHABLE, { cause: err });
    throw err;
  }
};

async function getJson(official: string, fetchImpl: typeof fetch): Promise<unknown> {
  const relayed = await request(viaPageServer(official), fetchImpl);
  const openData = new URL(official).origin === HKO_OPEN_DATA_ORIGIN;
  if (relayed.ok) {
    const text = await relayed.text();
    try {
      return parseJsonStrict(text);
    } catch (err) {
      // Some static hosts answer an unknown path with the app page instead of a 404.
      if (!openData) throw err;
    }
  } else if (relayed.status === 502 && (await relayed.text()).startsWith("HKO unreachable")) {
    throw new Error(HKO_UNREACHABLE);
  } else if (relayed.status !== 404 || !openData) {
    throw new Error(`HTTP ${relayed.status}`);
  }
  const direct = await request(official, fetchImpl);
  if (!direct.ok) throw new Error(`HTTP ${direct.status}`);
  return parseJsonStrict(await direct.text());
}

function settle<T>(work: () => Promise<T>): Promise<Part<T>> {
  return work().then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
  );
}

async function yesterdayRain(lang: HkoLang, date: string, fetchImpl: typeof fetch): Promise<DailyRain> {
  const key = `${lang}|${date}`;
  const cached = published.get(key);
  if (cached) return cached;
  const reading = parseDailyRainfall(await getJson(ryesUrl(date, lang), fetchImpl), date);
  published.set(key, reading);
  return reading;
}

export async function loadHkoLive(lang: HkoLang, fetchImpl: typeof fetch = (input, init) => fetch(input, init), clock: () => number = () => Date.now()): Promise<HkoLive> {
  const startedAt = Math.floor(clock() / 1000);
  const [current, hourly, yesterday] = await Promise.all([
    settle(async () => parseCurrentWeather(await getJson(currentWeatherUrl(lang), fetchImpl))),
    settle(async () => parseHourlyRainfall(await getJson(hourlyRainfallUrl(lang), fetchImpl))),
    settle(() => yesterdayRain(lang, previousHkDate(startedAt), fetchImpl)),
  ]);
  if (!current.ok && !hourly.ok && !yesterday.ok) throw new Error(current.error);
  return { readAt: Math.floor(clock() / 1000), current, hourly, yesterday };
}
