import { useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Icon, type IconName } from "./components/Icon";
import { LanguageToggle } from "./components/LanguageToggle";
import { Logo } from "./components/Logo";
import { ClockProvider, useNow } from "./hooks/useApp";
import { useMarkets } from "./hooks/useMarkets";
import { ToastProvider } from "./hooks/useToasts";
import { WalletProvider, useWallet } from "./hooks/useWallet";
import { type MessageKey, t } from "./i18n";
import { I18nProvider, useI18n } from "./i18n/I18nProvider";
import { CHAIN_NAMES, shortHex } from "./lib/chain";
import { localizeChainMessage } from "./lib/chainErrors";
import { isLocalMock, phaseOf } from "./lib/markets";
import { viewOf, type View } from "./lib/phase";
import { readSkipIntro } from "./lib/landing";
import { formatHktClock } from "./lib/time";
import { type Route, href, useRoute } from "./lib/routes";
import { type MetricDeployment, selectMetricDeployment } from "./metric/client";
import { MetricProvider, useMetricApp } from "./metric/context";
import { LandingPage } from "./pages/Landing";
import { MarketDetailPage } from "./pages/MarketDetail";
import { MarketsPage } from "./pages/Markets";
import { MyParticipationPage } from "./pages/MyParticipation";
import { OperationsPage } from "./pages/Operations";
import { SettlementPage } from "./pages/Settlement";
import { WaitingPage } from "./pages/Waiting";

const NAV: Array<{ key: "list" | View | "mine"; label: MessageKey; icon: IconName }> = [
  { key: "list", label: "nav.list", icon: "markets" },
  { key: "detail", label: "view.detail", icon: "event" },
  { key: "waiting", label: "view.waiting", icon: "hourglass" },
  { key: "settlement", label: "view.settlement", icon: "coins" },
  { key: "mine", label: "nav.mine", icon: "user" },
];

function navHref(key: (typeof NAV)[number]["key"], route: Route): string {
  if (key === "list") return href.list;
  if (key === "mine") return href.mine;
  return route.page === "market" ? href.market(route.id, key) : href.pick(key);
}

function activeKey(route: Route): string {
  if (route.page === "market" || route.page === "pick") return route.view;
  return route.page;
}

/** Whether the page was opened on the intro (no route, or #/), before any navigation. */
const parseInitialIsLanding = () => ["", "#", "#/"].includes(window.location.hash);

/** Each function has its own accent colour (CSS `data-section`). The markets colour is the brand's. */
const sectionOf = (key: string) => (key === "list" || key === "landing" || key === "not-found" ? "markets" : key);

export function WalletButton() {
  const api = useMetricApp();
  const wallet = useWallet();
  if (wallet.status === "unavailable") {
    return (
      <a className="tag wallet-none" href="https://metamask.io/download/" target="_blank" rel="noreferrer" title={t("wallet.noneTitle")} data-testid="wallet-none">
        {t("wallet.none")}
      </a>
    );
  }
  if (!wallet.account) {
    return (
      <button type="button" className="primary brand" onClick={() => void wallet.connect()} disabled={wallet.status === "connecting"} data-testid="connect">
        <Icon name="wallet" />
        {wallet.status === "connecting" ? t("wallet.connecting") : t("wallet.connect")}
      </button>
    );
  }
  if (!wallet.isCorrectChain) {
    return (
      <button type="button" className="secondary warn" onClick={() => void wallet.switchChain()} data-testid="switch-network">
        {t("wallet.wrong", { current: wallet.chainId ?? "?", target: CHAIN_NAMES[api.dep.chainId] ?? api.dep.chainId })}
      </button>
    );
  }
  return (
    <span className="account" data-testid="wallet-account" title={wallet.account}>
      <span className="avatar" aria-hidden="true">
        {wallet.account.slice(2, 3).toUpperCase()}
      </span>
      {shortHex(wallet.account)}
      {api.isAdmin && <small className="account-role">{t("wallet.admin")}</small>}
    </span>
  );
}

/** Navigation to a market view without a market in context: open the most relevant market, else explain. */
function PickMarket({ view }: { view: View }) {
  const now = useNow();
  const markets = useMarkets();
  const target = (markets.data ?? []).find((m) => viewOf(phaseOf(m, now)) === view);
  useEffect(() => {
    if (target) window.location.replace(href.market(target.id, view));
  }, [target, view]);
  if (markets.data && !target) {
    return (
      <div className="empty" data-testid="pick-empty">
        <p>{t("pick.none", { view: t(`view.${view}` as MessageKey) })}</p>
        <a href={href.list}>{t("nav.back")}</a>
      </div>
    );
  }
  return <div className="empty">{markets.error ? localizeChainMessage(markets.error) : t("market.loading")}</div>;
}

/** The five views (relative to the market in view, if any): a menu in the top bar, a tab bar at the bottom on phones. */
function MainNav({ route, active }: { route: Route; active: string }) {
  return (
    <nav className="main-nav" aria-label={t("nav.label")}>
      {NAV.map((n) => (
        <a key={n.key} className={`nav-item ${active === n.key ? "active" : ""}`} href={navHref(n.key, route)} aria-current={active === n.key ? "page" : undefined} data-section={sectionOf(n.key)} data-testid={`nav-${n.key}`}>
          <Icon name={n.icon} />
          <span className="nav-long">{t(n.label)}</span>
          <span className="nav-short">{t(`navShort.${n.key}` as MessageKey)}</span>
        </a>
      ))}
    </nav>
  );
}

/** Chain reads and the page clock (which follows chain time when the local chain runs ahead). */
function ChainState() {
  const api = useMetricApp();
  const now = useNow();
  const down = Boolean(api.fault);
  return (
    <span className="chain-state" data-testid="chain-state" title={down ? t("side.rpcDown") : t("side.rpcOk")}>
      <span className={`status-dot ${down ? "down" : ""}`} aria-hidden="true" />
      <span className="sr-only">{down ? t("side.rpcDown") : t("side.rpcOk")}</span>
      {formatHktClock(now, true)} <small>HKT</small>
    </span>
  );
}

/** Network notice and the top bar: brand, chain and oracle, language, wallet. */
function TopBar({ route, active }: { route: Route; active: string }) {
  const { dep } = useMetricApp();
  useI18n(); // re-render the bar when the language changes
  const local = isLocalMock(dep);
  const notice = local ? t("notice.local") : t("notice.sepolia");
  return (
    <>
      <div className="notice" data-testid="env-notice">
        <strong>{local ? t("notice.localTitle") : t("notice.sepoliaTitle")}</strong>
        <span title={notice}>{notice}</span>
        <span className="notice-tags">
          <span className="tag" data-testid="env-chain">
            {CHAIN_NAMES[dep.chainId] ?? dep.chainId} <small>{dep.chainId}</small>
          </span>
          <span className={`tag ${local ? "outline" : ""}`} data-testid="env-oracle">
            {local ? t("oracle.localMock") : t("oracle.canonical")}
          </span>
        </span>
      </div>
      <header className="topbar">
        <a className="brand" href={href.home} aria-label={t("brand.name")}>
          <Logo />
          <span className="brand-name">{t("brand.name")}</span>
        </a>
        <MainNav route={route} active={active} />
        <div className="top-actions">
          <ChainState />
          <a className={`icon-button ${active === "ops" ? "active" : ""}`} href={href.ops()} aria-current={active === "ops" ? "page" : undefined} title={t("nav.ops")} data-section="ops" data-testid="nav-ops">
            <Icon name="sliders" />
            <span className="sr-only">{t("nav.ops")}</span>
          </a>
          <LanguageToggle />
          <WalletButton />
        </div>
      </header>
    </>
  );
}

/** A deployment or read failure, with what to check next. The last good read stays on screen. */
function FaultBanner() {
  const api = useMetricApp();
  if (!api.fault) return null;
  return (
    <div className="banner" role="alert" data-testid="read-fault">
      <strong>{t("app.readFault")}</strong> {localizeChainMessage(api.fault)}
      <span className="banner-hint">{isLocalMock(api.dep) ? t("app.readFaultLocal") : t("app.readFaultSepolia")}</span>
    </div>
  );
}

function Shell() {
  const route = useRoute();
  const wallet = useWallet();
  const active = activeKey(route);
  useEffect(() => {
    // A returning visitor who asked for it opens the markets. The intro stays one click away (the brand link).
    if (parseInitialIsLanding() && readSkipIntro()) window.location.replace(href.list);
  }, []);
  if (route.page === "landing") {
    // The intro is a page of its own, with its own navigation, outside the app's frame.
    return (
      <ErrorBoundary resetKey={window.location.hash}>
        <LandingPage />
      </ErrorBoundary>
    );
  }
  return (
    <>
      <TopBar route={route} active={active} />
      <div className="shell" data-section={sectionOf(active)}>
        <div className="workspace">
          {wallet.error && (
            <p className="banner" role="alert">
              {localizeChainMessage(wallet.error)}
            </p>
          )}
          <FaultBanner />
          <main>
            <ErrorBoundary resetKey={window.location.hash}>
            {route.page === "list" && <MarketsPage tab={route.tab} />}
            {route.page === "market" && route.view === "detail" && <MarketDetailPage key={route.id} id={route.id} />}
            {route.page === "market" && route.view === "waiting" && <WaitingPage key={route.id} id={route.id} />}
            {route.page === "market" && route.view === "settlement" && <SettlementPage key={route.id} id={route.id} />}
            {route.page === "pick" && <PickMarket view={route.view} />}
            {route.page === "mine" && <MyParticipationPage />}
            {route.page === "ops" && <OperationsPage {...(route.id ? { id: route.id } : {})} {...(route.template ? { template: route.template } : {})} />}
            {route.page === "not-found" && (
              <div className="empty" data-testid="not-found">
                <h2>{t("app.notFound")}</h2>
                <p>{route.path}</p>
                <a href={href.list}>{t("nav.back")}</a>
              </div>
            )}
            </ErrorBoundary>
          </main>
          <footer>
            <span>{t("footer.source")}</span>
            <span>{t("footer.right")}</span>
          </footer>
        </div>
      </div>
    </>
  );
}

/** The provider tree: wallet, verified chain reads, clock, language, toasts. */
export function Root({ dep }: { dep: MetricDeployment }) {
  const identity = [dep.chainId, dep.publicRpcUrl, dep.contracts.PredictionMarket.address, dep.bindingTransactionHash].join(":");
  return (
    <WalletProvider key={identity} dep={dep}>
      <MetricProvider dep={dep}>
        <ClockProvider>
          <I18nProvider>
            <ToastProvider>
              <Shell />
            </ToastProvider>
          </I18nProvider>
        </ClockProvider>
      </MetricProvider>
    </WalletProvider>
  );
}

export function App() {
  let dep: MetricDeployment;
  try {
    dep = selectMetricDeployment();
  } catch (err) {
    return (
      <main role="alert" data-testid="config-error" style={{ padding: 30 }}>
        <h1>{t("app.configNeeded")}</h1>
        <p>{err instanceof Error ? err.message : String(err)}</p>
      </main>
    );
  }
  return <Root dep={dep} />;
}
