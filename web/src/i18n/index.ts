import { en } from "./en";
import { type Catalog, type MessageKey, zhCN } from "./zh-CN";

export type { MessageKey } from "./zh-CN";

export const LOCALES = [
  { code: "zh-CN", label: "简体中文", short: "中文" },
  { code: "en", label: "English", short: "EN" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const CATALOGS: Record<Locale, Catalog> = { "zh-CN": zhCN, en };

const STORAGE_KEY = "rain-or-shine.locale";
export const DEFAULT_LOCALE: Locale = "zh-CN";

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.code === value);
}

export function readStoredLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE; // storage blocked (private mode, sandboxed frame): fall back to the default
  }
}

export function storeLocale(locale: Locale): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage is unavailable. The choice still holds for this session.
    return;
  }
}

let active: Locale = readStoredLocale();

export const activeLocale = (): Locale => active;
export const setActiveLocale = (locale: Locale): void => {
  active = locale;
};

export type Params = Record<string, string | number | bigint>;

export function tSegments(key: MessageKey, params: Params): Array<{ text: string; param?: string }> {
  const template = CATALOGS[active][key];
  const segments: Array<{ text: string; param?: string }> = [];
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m.index > last) segments.push({ text: template.slice(last, m.index) });
    const name = m[1]!;
    segments.push(name in params ? { text: String(params[name]), param: name } : { text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < template.length) segments.push({ text: template.slice(last) });
  return segments;
}

export function t(key: MessageKey, params?: Params): string {
  const template = CATALOGS[active][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
