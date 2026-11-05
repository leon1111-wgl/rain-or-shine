import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type MessageKey, t } from "../../i18n";
import { useI18n } from "../../i18n/I18nProvider";
import { prefersReducedMotion } from "../../hooks/useInView";
import { href } from "../../lib/routes";
import { LanguageToggle } from "../LanguageToggle";
import { Logo } from "../Logo";

export const INTRO_SECTIONS = ["home", "markets", "data", "rules", "fees", "faq"] as const;
export type IntroSection = (typeof INTRO_SECTIONS)[number];
export const sectionId = (s: IntroSection) => `intro-${s}`;

export function scrollToSection(s: IntroSection) {
  document.getElementById(sectionId(s))?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
}

export function IntroNav() {
  const { locale } = useI18n();
  const [active, setActive] = useState<IntroSection>("home");
  const pills = useRef<Partial<Record<IntroSection, HTMLButtonElement | null>>>({});
  const marker = useRef<HTMLSpanElement | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = () => {
    const el = row.current;
    if (el) setMore({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [locale]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id.replace("intro-", "") as IntroSection);
      },
      { rootMargin: "-40% 0px -55% 0px" },
    );
    for (const s of INTRO_SECTIONS) {
      const el = document.getElementById(sectionId(s));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const pill = pills.current[active];
    if (pill && marker.current) {
      marker.current.style.width = `${pill.offsetWidth}px`;
      marker.current.style.transform = `translateX(${pill.offsetLeft}px)`;
    }
    const el = row.current;
    if (pill && el && (pill.offsetLeft < el.scrollLeft || pill.offsetLeft + pill.offsetWidth > el.scrollLeft + el.clientWidth)) {
      el.scrollTo({ left: pill.offsetLeft - (el.clientWidth - pill.offsetWidth) / 2, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
  }, [active, locale]);

  return (
    <header className="intro-nav" data-testid="intro-nav">
      <a className="intro-brand" href={href.home} aria-label={t("brand.name")}>
        <Logo />
        <span>{t("brand.name")}</span>
      </a>
      <nav className={`intro-pills ${more.left ? "more-left" : ""} ${more.right ? "more-right" : ""}`} ref={row} onScroll={measure} aria-label={t("intro.nav.label")}>
        <span className="intro-pill-marker" ref={marker} aria-hidden="true" />
        {INTRO_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            ref={(el) => {
              pills.current[s] = el;
            }}
            className={active === s ? "active" : ""}
            aria-current={active === s ? "true" : undefined}
            onClick={() => scrollToSection(s)}
            data-testid={`intro-pill-${s}`}
          >
            {t(`intro.nav.${s}` as MessageKey)}
          </button>
        ))}
      </nav>
      <div className="intro-nav-actions">
        <LanguageToggle />
        <a className="primary brand" href={href.list} data-testid="intro-enter">
          {t("intro.nav.enter")}
        </a>
      </div>
    </header>
  );
}
