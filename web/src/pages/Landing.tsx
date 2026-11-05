import { formatUnits } from "ethers";
import { useState, type ReactNode } from "react";
import { HowItWorks } from "../components/HowItWorks";
import { Icon, type IconName } from "../components/Icon";
import { IntroNav, scrollToSection, sectionId, type IntroSection } from "../components/landing/IntroNav";
import { LiveCard } from "../components/landing/LiveCard";
import { Marquee } from "../components/landing/Marquee";
import { Logo } from "../components/Logo";
import { MetricMark } from "../components/MetricMark";
import { Countdown, Ticking } from "../components/primitives";
import { useApp } from "../hooks/useApp";
import { prefersReducedMotion, useInView } from "../hooks/useInView";
import { useActivity, useMarkets } from "../hooks/useMarkets";
import { type MessageKey, t } from "../i18n";
import { MIN_BET_WEI, formatEth, formatEthFixed } from "../lib/amount";
import { explorerAddress } from "../lib/chain";
import { localizeChainMessage } from "../lib/chainErrors";
import { type IntroKind, introFigures, kindSummary, readSkipIntro, writeSkipIntro } from "../lib/landing";
import type { MarketData } from "../lib/markets";
import { href } from "../lib/routes";

function SkipIntro() {
  const [skip, setSkip] = useState(readSkipIntro);
  return (
    <label className="check-row intro-skip">
      <input
        type="checkbox"
        checked={skip}
        onChange={(e) => {
          setSkip(e.target.checked);
          writeSkipIntro(e.target.checked);
        }}
        data-testid="skip-intro"
      />
      {t("landing.skip")}
    </label>
  );
}

function Section({ id, title, sub, children }: { id: IntroSection; title: string; sub?: string; children: ReactNode }) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <section id={sectionId(id)} ref={ref} className={`intro-section ${seen ? "in" : ""}`} aria-labelledby={`${sectionId(id)}-title`}>
      <h2 id={`${sectionId(id)}-title`} className="intro-h2">
        {title}
      </h2>
      {sub && <p className="intro-sub">{sub}</p>}
      {children}
    </section>
  );
}

const BADGES: Array<{ key: MessageKey; icon: IconName }> = [
  { key: "intro.badge.data", icon: "rain" },
  { key: "intro.badge.uma", icon: "shield" },
  { key: "intro.badge.fee", icon: "coins" },
];

function Hero({ markets, now }: { markets: MarketData[] | undefined; now: bigint }) {
  return (
    <section id={sectionId("home")} className="intro-hero" aria-labelledby="intro-title">
      <div className="intro-hero-copy">
        <h1 id="intro-title" className="intro-title">
          <span className="line">{t("intro.hero.line1")}</span>
          <span className="line">
            <span className="mark">{t("intro.hero.line2")}</span>
          </span>
        </h1>
        <p className="intro-lead">{t("intro.hero.sub")}</p>
        <div className="intro-actions">
          <a className="primary brand" href={href.list} data-testid="enter-markets">
            {t("landing.enter")}
          </a>
          <button type="button" className="secondary" onClick={() => scrollToSection("rules")}>
            {t("list.rules")}
          </button>
        </div>
        <SkipIntro />
        <ul className="intro-badges">
          {BADGES.map((b) => (
            <li key={b.key}>
              <Icon name={b.icon} />
              {t(b.key)}
            </li>
          ))}
        </ul>
      </div>
      <LiveCard markets={markets} now={now} />
    </section>
  );
}

function Count({ seen, value, text, decimals = 0, unit }: { seen: boolean; value: number; text: string; decimals?: number; unit?: string }) {
  const shown = seen || prefersReducedMotion();
  return (
    <>
      <Ticking value={shown ? value : 0} text={shown ? text : (0).toFixed(decimals)} decimals={decimals} from={0} />
      {unit && <small> {unit}</small>}
    </>
  );
}

function Figures({ markets, items, now }: { markets: MarketData[] | undefined; items: ReturnType<typeof useActivity>; now: bigint }) {
  const [ref, seen] = useInView<HTMLDListElement>();
  if (!markets) {
    return (
      <dl className="intro-figures" ref={ref} data-testid="landing-figures" aria-busy="true">
        {(["open", "staked", "bets", "accounts"] as const).map((k) => (
          <div key={k}>
            <dt>{t(`intro.data.${k}`)}</dt>
            <dd>
              <span className="intro-note">{t("intro.card.loading")}</span>
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  const f = introFigures(markets, items.data ?? [], now);
  const reading = !items.data;
  return (
    <dl className="intro-figures" ref={ref} data-testid="landing-figures">
      <div>
        <dt>{t("intro.data.open")}</dt>
        <dd>
          <Count seen={seen} value={f.open} text={String(f.open)} />
        </dd>
      </div>
      <div>
        <dt>{t("intro.data.staked")}</dt>
        <dd>
          <Count seen={seen} value={Number(f.staked / 10n ** 12n) / 1e6} text={formatEthFixed(f.staked)} decimals={3} unit="ETH" />
        </dd>
      </div>
      <div>
        <dt>{t("intro.data.bets")}</dt>
        <dd>{reading ? <span className="intro-note">{items.error ? t("landing.tradeError") : t("landing.readingTrades")}</span> : <Count seen={seen} value={f.bets} text={String(f.bets)} />}</dd>
      </div>
      <div>
        <dt>{t("intro.data.accounts")}</dt>
        <dd>{reading ? <span className="intro-note">—</span> : <Count seen={seen} value={f.accounts} text={String(f.accounts)} />}</dd>
      </div>
    </dl>
  );
}

function KindCard({ kind, code, markets, now }: { kind: IntroKind; code: string; markets: MarketData[]; now: bigint }) {
  const s = kindSummary(markets, kind, now);
  return (
    <article className="intro-card kind-card" data-metric={kind} data-testid={`kind-${kind}`}>
      <MetricMark code={code} />
      <h3>{t(`intro.kind.${kind}.title` as MessageKey)}</h3>
      <p>{t(`intro.kind.${kind}.body` as MessageKey)}</p>
      <dl>
        <div>
          <dt>{t("intro.kind.markets")}</dt>
          <dd className="num">{t("intro.kind.count", { n: s.markets, open: s.open })}</dd>
        </div>
        <div>
          <dt>{t("intro.kind.staked")}</dt>
          <dd className="num">{formatEthFixed(s.staked)} ETH</dd>
        </div>
        <div>
          <dt>{t("intro.kind.next")}</dt>
          <dd>{s.nextClose === null ? <span className="muted">{t("intro.kind.none")}</span> : <Countdown target={s.nextClose} />}</dd>
        </div>
      </dl>
      <a className="secondary" href={href.list}>
        {t("intro.kind.view")}
      </a>
    </article>
  );
}

function RingCard() {
  const api = useApp();
  const [ref, seen] = useInView<HTMLDivElement>();
  const link = explorerAddress(api.dep, api.dep.contracts.PredictionMarket.address);
  return (
    <div className={`intro-card ring-card ${seen ? "in" : ""}`} ref={ref}>
      <svg className="ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="ring-track" cx="60" cy="60" r="52" />
        <circle className="ring-fill" cx="60" cy="60" r="52" pathLength={100} />
      </svg>
      <strong className="ring-value">100%</strong>
      <h3>{t("intro.ring.title")}</h3>
      <p>{t("intro.ring.body")}</p>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="intro-link">
          {t("intro.ring.contract")}
        </a>
      ) : (
        <span className="muted mono">{api.dep.contracts.PredictionMarket.address}</span>
      )}
    </div>
  );
}

function Fees() {
  const { dep } = useApp();
  const bond = `${formatUnits(BigInt(dep.oracle.policyBond), dep.oracle.bondDecimals)} ${dep.oracle.bondSymbol}`;
  const rows: Array<[MessageKey, string]> = [
    ["intro.fee.platform", t("intro.fee.platformValue")],
    ["intro.fee.gas", t("intro.fee.gasValue")],
    ["intro.fee.min", `${formatEth(MIN_BET_WEI)} ETH`],
    ["intro.fee.bond", t("intro.fee.bondValue", { bond })],
    ["intro.fee.oneSided", t("intro.fee.oneSidedValue")],
    ["intro.fee.timeout", t("intro.fee.timeoutValue")],
    ["intro.fee.rejected", t("intro.fee.rejectedValue")],
  ];
  return (
    <div className="intro-card fee-card">
      <table className="data-table" data-testid="intro-fees">
        <thead>
          <tr>
            <th scope="col">{t("intro.fees.item")}</th>
            <th scope="col">{t("intro.fees.value")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td>{t(label)}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FAQ = ["repeat", "both", "withdraw", "oneSided", "who", "timeout", "money"] as const;

function Questions() {
  return (
    <div className="intro-faq" data-testid="intro-faq">
      {FAQ.map((q, i) => (
        <details key={q} className="intro-card faq-item" {...(i === 0 ? { open: true } : {})}>
          <summary>{t(`intro.faq.${q}.q` as MessageKey)}</summary>
          <p>{t(`intro.faq.${q}.a` as MessageKey)}</p>
        </details>
      ))}
    </div>
  );
}

export function LandingPage() {
  const api = useApp();
  const markets = useMarkets();
  const activity = useActivity(markets.data);
  const all = markets.data ?? [];
  const sample = (kind: IntroKind) => (kind === "rain" ? "TOTAL_RAINFALL" : kind === "heat" ? "DAILY_MAX_TEMPERATURE" : "CUSTOM");
  return (
    <div className="intro" data-testid="landing">
      <IntroNav />
      <Hero markets={markets.data} now={api.now} />
      {markets.data && <Marquee markets={all} items={activity.data ?? []} now={api.now} />}
      {markets.error && !markets.data && (
        <p className="banner intro-banner" role="alert">
          {localizeChainMessage(markets.error)}
        </p>
      )}
      <Section id="markets" title={t("intro.markets.title")} sub={t("intro.markets.sub")}>
        <div className="kind-grid">
          {(["rain", "heat", "custom"] as const).map((k) => (
            <KindCard key={k} kind={k} code={sample(k)} markets={all} now={api.now} />
          ))}
        </div>
      </Section>
      <Section id="data" title={t("intro.data.title")} sub={t("intro.data.sub")}>
        <Figures markets={markets.data} items={activity} now={api.now} />
      </Section>
      <Section id="rules" title={t("intro.rules.title")} sub={t("intro.rules.sub")}>
        <div className="rules-grid-intro">
          <HowItWorks hours={72n} autoplay />
          <RingCard />
        </div>
      </Section>
      <Section id="fees" title={t("intro.fees.title")} sub={t("intro.fees.sub")}>
        <Fees />
      </Section>
      <Section id="faq" title={t("intro.faq.title")}>
        <Questions />
      </Section>
      <section className="intro-final" aria-labelledby="intro-final-title">
        <h2 id="intro-final-title" className="intro-h2">
          {t("intro.cta.title")}
        </h2>
        <p className="intro-sub">{t("intro.cta.sub")}</p>
        <a className="primary brand" href={href.list}>
          {t("landing.enter")}
        </a>
      </section>
      <footer className="intro-footer">
        <span className="intro-brand">
          <Logo />
          {t("brand.name")}
        </span>
        <span>{t("footer.source")}</span>
        <span>{t("intro.footer.note")}</span>
      </footer>
    </div>
  );
}
