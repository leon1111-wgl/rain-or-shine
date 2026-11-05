import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { type Locale, type MessageKey, activeLocale, setActiveLocale, storeLocale, t } from "./index";

interface I18nApi {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(activeLocale);
  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    storeLocale(next);
    setLocaleState(next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.title");
  }, [locale]);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nApi {
  return useContext(I18nContext) ?? { locale: activeLocale(), setLocale: setActiveLocale };
}

export function tNodes(key: MessageKey, nodes: Record<string, ReactNode>): ReactNode[] {
  const template = t(key);
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const index = match.index;
    out.push(template.slice(last, index));
    const name = match[1]!;
    out.push(<Fragment key={`${name}@${index}`}>{name in nodes ? nodes[name] : match[0]}</Fragment>);
    last = index + match[0].length;
  }
  out.push(template.slice(last));
  return out;
}
