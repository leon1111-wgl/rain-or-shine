// Operations, outside the five member views. It shows the deployment and bond token, the administrator's new-market
// flow and metric registry, and the proposer's result steps. The contracts enforce every permission. This page only
// shows each action to the account that can use it.

import { formatUnits, parseUnits } from "ethers";
import { ClientStatus } from "../components/ClientStatus";
import { CopyButton, PageHeading, PhaseBadge } from "../components/primitives";
import { MetricMark } from "../components/MetricMark";
import { useApp } from "../hooks/useApp";
import { useMarkets } from "../hooks/useMarkets";
import { useWallet } from "../hooks/useWallet";
import { t } from "../i18n";
import { CHAIN_NAMES, explorerAddress, shortHex } from "../lib/chain";
import { type MarketData, isLocalMock, marketTagOf, phaseOf, shortLabelOf } from "../lib/markets";
import { href } from "../lib/routes";
import { localTokenOf } from "../metric/client";
import { Registry } from "../metric/forms";
import { NewMarket } from "../metric/new-market";
import { OracleActions } from "../metric/OracleActions";

function AddressRow({ label, address }: { label: string; address: string }) {
  const { dep } = useApp();
  const link = explorerAddress(dep, address);
  return (
    <>
      <dt>{label}</dt>
      <dd className="mono">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer">
            {shortHex(address)}
          </a>
        ) : (
          shortHex(address)
        )}
        <CopyButton text={address} />
      </dd>
    </>
  );
}

function Deployment() {
  const api = useApp();
  const wallet = useWallet();
  const local = isLocalMock(api.dep);
  const o = api.dep.oracle;
  return (
    <section className="card ops-section" aria-labelledby="ops-env" data-testid="ops-env">
      <div className="panel-heading">
        <h2 id="ops-env">{t("ops.env.title")}</h2>
        <span className={`tag ${api.ready ? "" : "outline"}`}>{api.ready ? t("ops.env.verified") : t("ops.env.checking")}</span>
      </div>
      <dl className="review-list">
        <dt>{t("review.network")}</dt>
        <dd>
          {CHAIN_NAMES[api.dep.chainId] ?? api.dep.chainId} <small>{api.dep.chainId}</small>
        </dd>
        <AddressRow label="PredictionMarket" address={api.dep.contracts.PredictionMarket.address} />
        <AddressRow label="UmaMetricOracleAdapter" address={api.dep.contracts.UmaMetricOracleAdapter.address} />
        <AddressRow label={local ? t("ops.env.mockOracle") : "UMA OOV3"} address={o.optimisticOracleV3} />
        <AddressRow label={t("ops.env.bond", { symbol: o.bondSymbol })} address={o.bondCurrency} />
        <AddressRow label={t("ops.env.admin")} address={api.dep.admin} />
        <dt>{t("ops.env.myBond")}</dt>
        <dd data-testid="bond-balance">{wallet.account && api.data ? `${formatUnits(api.data.bondBalance, o.bondDecimals)} ${o.bondSymbol}` : "—"}</dd>
      </dl>
      <p className="fine-print">{t("ops.env.bondNote", { symbol: o.bondSymbol })}</p>
      {local ? (
        <button
          type="button"
          className="secondary"
          disabled={!api.canWrite}
          onClick={() => void api.run(t("ops.env.mintLabel"), async (signer) => localTokenOf(api.dep, signer).mint(await signer.getAddress(), parseUnits("100", o.bondDecimals)))}
          data-testid="mint-bond"
        >
          {t("ops.env.mint", { symbol: o.bondSymbol })}
        </button>
      ) : (
        <p className="fine-print">{t("ops.env.sepoliaBond")}</p>
      )}
      <p className="fine-print">{local ? t("ops.env.localNote") : t("ops.env.sepoliaNote")}</p>
    </section>
  );
}

function AdminArea({ template }: { template: MarketData | undefined }) {
  const api = useApp();
  if (api.isAdmin) {
    return (
      <>
        {/* A fresh form for each template, so its inputs start from that market. */}
        <NewMarket key={template?.id ?? "blank"} {...(template ? { template } : {})} />
        <Registry />
      </>
    );
  }
  return (
    <section className="card ops-section" data-testid="admin-note">
      <h2>{t("ops.admin.title")}</h2>
      <p className="subtext">{t("ops.admin.body")}</p>
      <dl className="review-list">
        <AddressRow label={t("ops.env.admin")} address={api.dep.admin} />
      </dl>
    </section>
  );
}

/** Every market with its phase and proposer, and the selected one's submission, dispute and settlement steps. */
function ResultArea({ markets, id }: { markets: MarketData[]; id: number | undefined }) {
  const api = useApp();
  const pending = markets.filter((m) => ["AWAITING_PROPOSAL", "PROPOSED", "DISPUTED", "SETTLEABLE", "WAITING_DATA", "WAITING_OBSERVATION", "OPEN"].includes(phaseOf(m, api.now)));
  const selected = markets.find((m) => m.id === id) ?? pending[0];
  return (
    <section className="ops-results" aria-labelledby="ops-results" data-testid="ops-results">
      <div className="card table-card">
        <div className="panel-heading">
          <h2 id="ops-results">{t("ops.results.title")}</h2>
        </div>
        {markets.length === 0 ? (
          <p className="subtext ops-empty">{t("ops.results.none")}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table" data-testid="ops-markets">
              <thead>
                <tr>
                  <th scope="col">{t("table.event")}</th>
                  <th scope="col">{t("mine.col.status")}</th>
                  <th scope="col">{t("ops.results.proposer")}</th>
                  {api.isAdmin && <th scope="col"><span className="sr-only">{t("new.useTemplate")}</span></th>}
                </tr>
              </thead>
              <tbody>
                {markets.map((m) => (
                  <tr key={m.id} className={m.id === selected?.id ? "selected" : ""}>
                    <td>
                      <a className="metric-cell" href={href.ops(m.id)} aria-current={m.id === selected?.id ? "true" : undefined}>
                        <MetricMark code={m.metric.code} small />
                        <span className="muted num">{m.id}</span> {shortLabelOf(m)}
                      </a>
                    </td>
                    <td>
                      <PhaseBadge phase={phaseOf(m, api.now)} tag={marketTagOf(m)} />
                    </td>
                    <td className="mono muted">{shortHex(m.proposer)}</td>
                    {api.isAdmin && (
                      <td>
                        <a className="text-link" href={href.template(m.id)} data-testid={`template-${m.id}`}>
                          {t("new.useTemplate")}
                        </a>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selected && (
        <>
          <OracleActions market={selected.view} part="result" />
          <OracleActions market={selected.view} part="oracle" />
          <OracleActions market={selected.view} part="time" />
        </>
      )}
    </section>
  );
}

export function OperationsPage({ id, template }: { id?: number; template?: number }) {
  const markets = useMarkets();
  const source = template === undefined ? undefined : markets.data?.find((m) => m.id === template);
  return (
    <>
      <PageHeading title={t("ops.title")} sub={t("ops.sub")} />
      <div className="ops-grid">
        <Deployment />
        <AdminArea template={source} />
      </div>
      <ResultArea markets={markets.data ?? []} id={id} />
      <ClientStatus />
    </>
  );
}
