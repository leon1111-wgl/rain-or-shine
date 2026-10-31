import { LOCALES, t } from "../i18n";
import { useI18n } from "../i18n/I18nProvider";
import { Icon } from "./Icon";

/** 中 / EN: one click switches every page. */
export function LanguageToggle() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="lang-toggle" role="group" aria-label={t("lang.label")} data-testid="language">
      <Icon name="globe" />
      {LOCALES.map((l) => (
        <button key={l.code} type="button" lang={l.code} className={locale === l.code ? "active" : ""} aria-pressed={locale === l.code} onClick={() => setLocale(l.code)} data-testid={`lang-${l.code}`}>
          {l.short}
        </button>
      ))}
    </div>
  );
}
