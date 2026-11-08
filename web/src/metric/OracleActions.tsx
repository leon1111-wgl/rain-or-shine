import { useLayoutEffect, useRef, useState } from "react";
import { ZeroHash, dataLength, formatUnits, toUtf8Bytes, type JsonRpcSigner } from "ethers";
import {
  assertNumericMarketRulesMatchChain, type NumericMarketRules,
} from "@shared/metric/numeric-rules";
import { assertCustomNumericProfile, isCustomNumericRules } from "@shared/metric/custom-profile";
import { assertHkoNumericProfile, assertSportsNumericProfile } from "@shared/metric/numeric-profiles";
import {
  MAX_EXCERPT_BYTES, MAX_SOURCE_DOCUMENT_BYTES, buildCustomNumericProposal, buildHkoFieldProposal, buildHkoNumericProposal,
  buildSportsNumericProposal, type NumericProposal, type NumericProposalContext,
} from "@shared/metric/numeric-proposals";
import { buildObservationBundle } from "@shared/weather/observation-evidence";
import { parseDailyExtractObservation } from "@shared/weather/observations";
import type { RawEvidence } from "@shared/weather/parse";
import { dailyExtractMonthUrl } from "@shared/weather/profile";
import { WeatherDataError, decodeUtf8, parseJsonStrict } from "@shared/weather/strict";
import { t } from "../i18n";
import { viaPageServer } from "../lib/hko";
import { formatReading, unitOf } from "../lib/markets";
import { formatHktMinute } from "../lib/time";
import {
  adapterOf, assertOracleSubmissionSupported, marketOf, mockOracleOf, numericContextForMarket, oracleOf, readNumericContext, tokenOf, type MarketView,
} from "./client";
import { downloadText, useMetricApp } from "./context";
import { Field } from "./form-parts";
import { InfoTip, ShortHash } from "../components/primitives";

const HKO_FILE_LIMIT = 5_000_000;
const SPORTS_FILE_LIMIT = MAX_EXCERPT_BYTES;
type SourceKind = "hko" | "custom" | "hko-field" | "sports";
type ImportedResult = {
  owner: string;
  request: number;
  name: string;
} & (
  | { kind: "hko"; bundle: unknown; payload: NumericProposal }
  | { kind: "hko-field"; raw: RawEvidence; payload: NumericProposal }
  | { kind: "sports"; rawBytes: Uint8Array; capturedAt: number; payload: NumericProposal }
  | { kind: "custom"; rawBytes: Uint8Array; capturedAt: number }
);
interface ClaimPreview {
  owner: string;
  request: number;
  payload: NumericProposal;
  outcome: bigint;
}
export type PanelPart = "result" | "oracle" | "time" | "all";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function sourceKind(rules: NumericMarketRules): SourceKind {
  if (isCustomNumericRules(rules)) return assertCustomNumericProfile(rules).hko ? "hko-field" : "custom";
  if (rules.synthetic) {
    assertSportsNumericProfile(rules);
    return "sports";
  }
  assertHkoNumericProfile(rules);
  return "hko";
}
function hkoDateOf(rules: NumericMarketRules): string | null {
  if (isCustomNumericRules(rules)) return assertCustomNumericProfile(rules).hko?.targetDate ?? null;
  return assertHkoNumericProfile(rules).targetDate;
}
const isDailyExtract = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) && "stn" in value;
const looksLikeJson = (bytes: Uint8Array) => /^\s*[{[]/.test(new TextDecoder().decode(bytes.subarray(0, 64)));
const FETCH_TIMEOUT_MS = 20_000;

export function OracleActions({ market, part = "all" }: { market: MarketView; part?: PanelPart }) {
  const api = useMetricApp();
  const times = market.config.times;
  const identity = [
    api.dep.chainId, api.dep.publicRpcUrl, api.dep.deployedAt, api.dep.bindingTransactionHash,
    api.dep.contracts.PredictionMarket.address, api.dep.contracts.UmaMetricOracleAdapter.address,
    api.wallet.account, api.wallet.chainId, api.wallet.epoch, market.id, market.rulesHash,
    market.rulesDocument, market.metric.id, market.metric.rulesHash,
    market.metric.code, market.metric.unit, market.metric.minValue, market.metric.maxValue,
    market.metric.valueStep, market.metric.allowsTrace, market.config.proposer,
    market.config.sourceId, market.config.subjectId,
    market.config.condition.metricId, market.config.condition.comparison,
    market.config.condition.lower, market.config.condition.upper,
    times.openAt, times.closeAt, times.observationStart, times.observationEnd,
    times.earliestAssertionAt, times.proposalCutoff, times.refundAt, times.assertionLiveness,
    market.assertion.assertionId,
  ].join(":");
  // A new identity resets all local state. This includes a switch from A to B and back to A.
  return <OracleActionsBody key={identity} market={market} identity={identity} part={part} />;
}

function OracleActionsBody({ market, identity, part }: { market: MarketView; identity: string; part: PanelPart }) {
  const api = useMetricApp();
  const local = api.dep.environment === "LOCAL_MOCK" && api.dep.chainId === 31337;
  const [imported, setImported] = useState<ImportedResult | null>(null);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [loading, setLoading] = useState<{ owner: string; request: number } | null>(null);
  const [importError, setImportError] = useState<{ owner: string; request: number; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const [pasted, setPasted] = useState("");
  const [readingText, setReadingText] = useState("");
  const [excerptText, setExcerptText] = useState("");
  const [fetchState, setFetchState] = useState<{ owner: string; state: "busy" | "manual" | "error"; text: string } | null>(null);
  const times = market.config.times;
  const now = api.data?.now ?? 0;
  const assertionId = market.assertion.assertionId;
  const hasAssertion = assertionId !== ZeroHash;
  const currentIdentity = useRef(identity);
  useLayoutEffect(() => {
    currentIdentity.current = identity;
    return () => {
      currentIdentity.current = "";
    };
  }, [identity]);

  const isCurrent = (owner: string, request: number) =>
    owner === identity && currentIdentity.current === owner && sequence.current === request;
  const selection = imported?.owner === identity ? imported : null;
  const currentPreview = preview?.owner === identity && preview.request === selection?.request ? preview : null;
  const importing = loading?.owner === identity;
  const currentError = importError?.owner === identity ? importError.text : "";

  let rules: NumericMarketRules | undefined;
  let kind: SourceKind | undefined;
  let unsupported = "";
  try {
    rules = assertNumericMarketRulesMatchChain(market.rulesDocument, numericContextForMarket(market));
    kind = sourceKind(rules);
  } catch (error) {
    unsupported = t("result.unsupported", { reason: messageOf(error) });
  }
  const custom = kind === "custom" || kind === "hko-field";
  const active = market.effectiveTerminal === 0n;
  const isProposer = api.wallet.account?.toLowerCase() === market.config.proposer.toLowerCase();
  const canPropose = api.canWrite && active && isProposer && !hasAssertion
    && now >= Number(times.earliestAssertionAt) && now < Number(times.proposalCutoff);
  const readyToPropose = canPropose && !!kind && !!selection && !importing && (selection.kind !== "custom" || readingText.trim() !== "");
  const bond = api.data?.bondAmount ?? 0n;

  const clearResult = () => {
    sequence.current++;
    setImported(null);
    setPreview(null);
    setLoading(null);
    setImportError(null);
    setPasted("");
    if (fileInput.current) fileInput.current.value = "";
  };

  const customPayload = (selected: Extract<ImportedResult, { kind: "custom" }>, context: NumericProposalContext) =>
    buildCustomNumericProposal({
      rawBytes: selected.rawBytes, reading: readingText, capturedAt: selected.capturedAt,
      ...(excerptText ? { excerpt: toUtf8Bytes(excerptText) } : {}),
    }, context);

  const loadResult = async (file?: File | { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer>; type: string }) => {
    const request = ++sequence.current;
    const owner = identity;
    setImported(null);
    setPreview(null);
    setImportError(null);
    setLoading(file ? { owner, request } : null);
    if (!file) return;
    try {
      if (api.busy) throw new Error(t("result.busy"));
      if (!kind) throw new Error(unsupported || t("result.noRules"));
      const limit = kind === "custom" ? MAX_SOURCE_DOCUMENT_BYTES : kind === "sports" ? SPORTS_FILE_LIMIT : HKO_FILE_LIMIT;
      if (file.size === 0 || file.size > limit) {
        throw new Error(t(kind === "custom" ? "result.customSize" : kind === "sports" ? "result.sportsSize" : "result.hkoSize"));
      }

      // Reject an early upload before reading it. Never carry it across the observation deadline.
      const beforeRead = await readNumericContext(api.dep, api.reader, market.id);
      if (!isCurrent(owner, request)) return;
      const beforeRules = assertNumericMarketRulesMatchChain(market.rulesDocument, beforeRead.expected);
      if (sourceKind(beforeRules) !== kind) throw new Error(t("result.rulesChanged"));
      if (beforeRead.chainTimestamp < beforeRules.config.times.observationEnd) {
        throw new Error(t("result.tooEarly"));
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent(owner, request)) return;
      if (bytes.length === 0 || bytes.length > limit) throw new Error(t("result.sizeAfterRead"));
      const fresh = await readNumericContext(api.dep, api.reader, market.id);
      if (!isCurrent(owner, request)) return;
      const context = { rulesDocument: market.rulesDocument, ...fresh };
      let next: ImportedResult;
      if (kind === "custom") {
        // The download time is fixed at import. The check and the submission keep it.
        next = { kind, owner, request, name: file.name, rawBytes: bytes, capturedAt: fresh.chainTimestamp };
      } else if (kind === "hko-field") {
        const raw: RawEvidence = {
          bytes, sourceURL: beforeRules.source.uri, fetchedAt: new Date(fresh.chainTimestamp * 1000).toISOString(),
          httpStatus: 200, contentType: file.type || null, lastModified: null,
        };
        next = { kind, owner, request, name: file.name, raw, payload: buildHkoFieldProposal(raw, context) };
      } else if (kind === "sports") {
        const capturedAt = fresh.chainTimestamp;
        next = { kind, owner, request, name: file.name, rawBytes: bytes, capturedAt, payload: buildSportsNumericProposal(bytes, capturedAt, context) };
      } else {
        const parsed = parseJsonStrict(decodeUtf8(bytes));
        let bundle = parsed;
        if (isDailyExtract(parsed)) {
          const raw: RawEvidence = {
            bytes, sourceURL: beforeRules.source.uri, fetchedAt: new Date(fresh.chainTimestamp * 1000).toISOString(),
            httpStatus: 200, contentType: file.type || null, lastModified: null,
          };
          const metric = beforeRules.metric.code === "TOTAL_RAINFALL" ? "TOTAL_RAINFALL_MM" : "DAILY_MAX_TEMPERATURE_C";
          bundle = buildObservationBundle(raw, parseDailyExtractObservation(raw, assertHkoNumericProfile(beforeRules).targetDate, metric));
        }
        const payload = buildHkoNumericProposal(bundle, context);
        next = { kind, owner, request, name: file.name, bundle, payload };
      }
      if (isCurrent(owner, request)) setImported(next);
    } catch (error) {
      if (isCurrent(owner, request)) {
        const unpublished = error instanceof WeatherDataError && error.code === "DATA_UNAVAILABLE";
        setImportError({ owner, request, text: unpublished ? t("result.notPublished") : messageOf(error) });
        if (fileInput.current) fileInput.current.value = "";
      }
    } finally {
      if (isCurrent(owner, request)) setLoading(null);
    }
  };

  const fetchFromHko = async () => {
    const date = rules ? hkoDateOf(rules) : null;
    if (!date) return;
    const owner = identity;
    const official = dailyExtractMonthUrl(date);
    const name = official.slice(official.lastIndexOf("/") + 1);
    setFetchState({ owner, state: "busy", text: "" });
    let bytes: Uint8Array;
    try {
      const response = await fetch(viaPageServer(official), { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (currentIdentity.current !== owner) return;
      if (response.status === 404) {
        setFetchState({ owner, state: "manual", text: t("result.fetchManual") });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (currentIdentity.current === owner) setFetchState({ owner, state: "error", text: t("result.fetchFailed", { reason: messageOf(error) }) });
      return;
    }
    if (currentIdentity.current !== owner) return;
    // Some static hosts answer a missing path with the app page instead of a 404.
    if (!looksLikeJson(bytes)) {
      setFetchState({ owner, state: "manual", text: t("result.fetchManual") });
      return;
    }
    setFetchState(null);
    await loadResult({ name, size: bytes.length, type: "application/json", arrayBuffer: () => Promise.resolve(bytes.slice().buffer) });
  };

  const prepareClaim = async (signer: JsonRpcSigner) => {
    const selected = selection;
    if (!selected) throw new Error(t("result.importFirst"));
    const guard = () => {
      if (!isCurrent(selected.owner, selected.request)) {
        throw new Error(t("result.changed"));
      }
    };
    guard();
    const fresh = await readNumericContext(api.dep, api.reader, market.id);
    guard();
    const context = { rulesDocument: market.rulesDocument, ...fresh };
    const payload = selected.kind === "custom" ? customPayload(selected, context)
      : selected.kind === "hko-field" ? buildHkoFieldProposal(selected.raw, context)
        : selected.kind === "sports" ? buildSportsNumericProposal(selected.rawBytes, selected.capturedAt, context)
          : buildHkoNumericProposal(selected.bundle, context);
    const account = await signer.getAddress();
    guard();
    if (!api.wallet.account || account.toLowerCase() !== api.wallet.account.toLowerCase()) {
      throw new Error(t("result.signerChanged"));
    }
    // Both checks are needed. They cover the proposer, the state and the proposal window.
    // checkProposal also returns the outcome for this reading.
    const outcome = await marketOf(api.dep, signer).checkProposal(market.id, account, payload.reading, payload.evidence.rawSha256);
    guard();
    const adapter = adapterOf(api.dep, signer);
    await adapter.previewClaim(market.id, payload.reading, payload.evidence);
    guard();
    return { payload, adapter, selected, guard, outcome: BigInt(outcome) };
  };

  const previewClaim = () => api.action(t("result.reviewLabel"), async () => {
    setPreview(null);
    const owner = identity;
    const request = selection?.request;
    const signer = await api.wallet.getSigner();
    if (request === undefined || !isCurrent(owner, request)) {
      throw new Error(t("result.changedReview"));
    }
    const checked = await prepareClaim(signer);
    checked.guard();
    setPreview({
      owner: checked.selected.owner, request: checked.selected.request,
      payload: checked.payload, outcome: checked.outcome,
    });
  });

  const submit = () => api.run(t("result.submitLabel"), async (signer) => {
    setPreview(null);
    const checked = await prepareClaim(signer);
    checked.guard();
    await assertOracleSubmissionSupported(api.dep, signer);
    checked.guard();
    setPreview({
      owner: checked.selected.owner, request: checked.selected.request,
      payload: checked.payload, outcome: checked.outcome,
    });
    // Run a static call first. A bond or allowance problem then shows before the wallet prompt.
    await checked.adapter.propose.staticCall(market.id, checked.payload.reading, checked.payload.evidence, bond);
    checked.guard();
    return checked.adapter.propose(market.id, checked.payload.reading, checked.payload.evidence, bond);
  });

  const oracleAssertion = market.oracleAssertion;
  const canDispute = api.canWrite && !!oracleAssertion && !oracleAssertion.settled
    && !market.assertion.disputed && now < Number(oracleAssertion.expirationTime);
  const canSettle = api.canWrite && !!oracleAssertion && !oracleAssertion.settled
    && (local ? market.assertion.disputed ? market.mockResolutionReady : now >= Number(oracleAssertion.expirationTime)
      : market.settlementReady === true);
  const canSimulate = local && api.canWrite && api.isAdmin && market.assertion.disputed
    && !!oracleAssertion && !oracleAssertion.settled && !market.mockResolutionReady;
  let draftProblem = "";
  let draft: NumericProposal | undefined;
  if (selection?.kind === "custom" && readingText.trim() && rules) {
    try {
      draft = customPayload(selection, {
        rulesDocument: market.rulesDocument, expected: numericContextForMarket(market), chainTimestamp: Math.max(now, selection.capturedAt),
      });
    } catch (error) {
      draftProblem = messageOf(error);
    }
  }
  const displayedPayload = currentPreview?.payload ?? (selection && selection.kind !== "custom" ? selection.payload : draft);
  const dispute = () => api.run(t("oracle.disputeLabel"), async (signer) => {
    const disputer = await signer.getAddress();
    await assertOracleSubmissionSupported(api.dep, signer);
    if (currentIdentity.current !== identity) throw new Error(t("oracle.changedDispute"));
    return oracleOf(api.dep, signer).disputeAssertion(assertionId, disputer);
  });
  const settle = () => api.run(t("oracle.settleLabel"), async (signer) => {
    if (!local) {
      await oracleOf(api.dep, signer).settleAssertion.staticCall(assertionId);
      if (currentIdentity.current !== identity) throw new Error(t("oracle.changedSettle"));
    }
    return adapterOf(api.dep, signer).settle(assertionId);
  });
  const show = (p: Exclude<PanelPart, "all">) => part === "all" || part === p;
  const reading = (kindCode: bigint | number, value: bigint | number) =>
    BigInt(kindCode) === 2n ? t("result.trace") : `${formatReading(value, market.metric)} ${unitOf(market.metric.unit)}`;

  return <div className="oracle-panel" data-testid="oracle-panel">
    {show("result") && <section className="card oracle-section" aria-labelledby={`result-${market.id}`}>
      <h3 id={`result-${market.id}`}>{t("result.title")}</h3>
      <p className="subtext">{t("result.proposer", { proposer: market.config.proposer, bond: formatUnits(bond, api.dep.oracle.bondDecimals), symbol: api.dep.oracle.bondSymbol })}</p>
      {unsupported && <p className="input-note error" role="alert">{unsupported}{t("result.unsupportedHint")}</p>}
      {kind === "hko" && <p className="subtext">{t("result.hkoHow")}</p>}
      {kind === "custom" && <p className="subtext">{t("result.customHow", { bytes: MAX_EXCERPT_BYTES })}</p>}
      {kind === "hko-field" && <p className="subtext">{t("result.fieldHow")}</p>}
      {kind === "sports" && <p className="callout">{t("result.syntheticNote")}</p>}
      {kind === "sports" && <p className="subtext">{t("result.sportsHow")}</p>}
      {(kind === "hko" || kind === "hko-field") && rules && <div className="simple-row actions">
        <button type="button" className="secondary" data-testid="result-fetch"
          disabled={!api.ready || api.busy || !active || hasAssertion || now < Number(times.earliestAssertionAt) || fetchState?.state === "busy"}
          onClick={() => void fetchFromHko()}>{fetchState?.owner === identity && fetchState.state === "busy" ? t("result.fetching") : t("result.fetch")}</button>
        {fetchState?.owner === identity && fetchState.state !== "busy" && <span className={`input-note ${fetchState.state === "error" ? "error" : ""}`} role="status" data-testid="result-fetch-note">
          {fetchState.text} {hkoDateOf(rules) && <a href={dailyExtractMonthUrl(hkoDateOf(rules)!)} target="_blank" rel="noreferrer">{t("result.fetchOpen")}</a>}
        </span>}
      </div>}
      <Field title={custom ? t("result.uploadDocument") : t("result.upload")}>
        <span className="file-picker">
          <span className="secondary file-button">{t("result.choose")}</span>
          <span className="file-name">{importing ? t("result.checking") : selection?.name ?? t("result.noFile")}</span>
          <input ref={fileInput} className="file-input" aria-label={custom ? t("result.uploadDocument") : t("result.upload")} type="file" accept={kind === "custom" ? undefined : kind === "sports" ? ".json,application/json" : ".json,.xml,application/json,text/xml"} data-testid="result-file"
            disabled={!api.ready || api.busy || !kind || !active || hasAssertion}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void loadResult(file);
            }} />
        </span>
      </Field>
      {kind === "custom" && <>
        <Field title={t("result.paste")}>
          <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} disabled={!api.ready || api.busy || !active || hasAssertion} data-testid="result-paste" />
        </Field>
        <div className="simple-row actions">
          <button type="button" className="secondary" disabled={!pasted || !api.ready || api.busy || !active || hasAssertion} data-testid="result-use-paste"
            onClick={() => {
              const bytes = toUtf8Bytes(pasted);
              void loadResult({ name: t("result.pastedName"), size: bytes.length, type: "text/plain", arrayBuffer: () => Promise.resolve(bytes.slice().buffer) });
            }}>{t("result.usePaste")}</button>
        </div>
        <div className="form-grid">
          <Field title={t("result.readingInput", { unit: unitOf(market.metric.unit) })}>
            <input value={readingText} onChange={(event) => { setReadingText(event.target.value); setPreview(null); }} placeholder={market.metric.allowsTrace ? "12.3 / Trace" : "12.3"} data-testid="result-reading-input" />
          </Field>
        </div>
        <Field title={t("result.excerpt", { bytes: MAX_EXCERPT_BYTES })}>
          <textarea value={excerptText} onChange={(event) => { setExcerptText(event.target.value); setPreview(null); }} data-testid="result-excerpt" />
        </Field>
        {draftProblem && <p className="input-note error" role="alert" data-testid="result-draft-problem">{draftProblem}</p>}
      </>}
      <div className="simple-row actions">
        <button type="button" className="secondary" disabled={api.busy || (!selection && !importing && !currentError)} onClick={clearResult}>{t("result.clear")}</button>
        <button type="button" className="secondary" onClick={() => downloadText(`market-${market.id}-rules.json`, market.rulesDocument)}>{t("result.downloadRules")}</button>
      </div>
      {importing && <p role="status" className="subtext">{t("result.reading")}</p>}
      {currentError && <p className="input-note error" role="alert">{currentError}</p>}
      {selection && <p className="subtext">{t("result.imported", { name: selection.name })}</p>}
      {displayedPayload && <dl className="review-list" data-testid="result-reading">
        <dt>{t("result.observed")}</dt>
        <dd>{reading(displayedPayload.reading.kind, displayedPayload.reading.value)}</dd>
        <dt>{t("result.captured")}</dt>
        <dd>{formatHktMinute(BigInt(displayedPayload.evidence.capturedAt))}</dd>
        {(custom || kind === "sports") && <>
          <dt>
            {t("fingerprint.data")} <InfoTip text={t("fingerprint.dataTipSource")} />
          </dt>
          <dd>
            <ShortHash value={displayedPayload.evidence.rawSha256} testId="result-sha256" />
          </dd>
          <dt>{t("result.excerptOnChain")}</dt>
          <dd data-testid="result-excerpt-size">{t("result.bytes", { n: dataLength(displayedPayload.evidence.excerpt) })}</dd>
        </>}
      </dl>}
      <div className="simple-row actions">
        <button type="button" className="secondary" disabled={!readyToPropose} onClick={() => void previewClaim()}>{t("result.check")}</button>
        <button type="button" className="secondary" disabled={!readyToPropose} onClick={() => void api.run(t("result.approveLabel"), (signer) => tokenOf(api.dep, signer).approve(api.dep.contracts.UmaMetricOracleAdapter.address, bond))} data-testid="approve-bond">{t("result.approve")}</button>
        <button type="button" className="primary accent" disabled={!readyToPropose} onClick={() => void submit()} data-testid="propose">{t("result.submit")}</button>
      </div>
      <p className="fine-print">{t("result.checksNote")}</p>
      {local && <p className="fine-print">{t("result.localMockNote")}</p>}
      {kind === "hko" && market.metric.allowsTrace && <p className="fine-print">{t("result.traceNote")}</p>}
      {currentPreview && <p role="status" className="yes-text">{t("result.passed")}</p>}
      {currentPreview && <p role="status" data-testid="result-outcome">{t("result.implied", { outcome: currentPreview.outcome === 1n ? "Yes" : "No" })}</p>}
    </section>}

    {show("oracle") && hasAssertion && <section className="card oracle-section" aria-labelledby={`oracle-${market.id}`}>
      <h3 id={`oracle-${market.id}`}>{t("oracle.title")}</h3>
      <p>{t("oracle.submitted", { reading: reading(market.assertion.reading.kind, market.assertion.reading.value) })} {market.assertion.rejected ? t("oracle.rejected") : market.assertion.returned ? t("oracle.returned") : market.assertion.disputed ? t("oracle.disputed") : t("oracle.undisputed")}</p>
      {oracleAssertion && <p className="subtext">{t("oracle.deadline", { time: formatHktMinute(oracleAssertion.expirationTime), bond: formatUnits(oracleAssertion.bond, api.dep.oracle.bondDecimals), symbol: api.dep.oracle.bondSymbol })}</p>}
      {market.settlementUnavailable && <p className="subtext">{t("oracle.notYet")}</p>}
      {!local && <p className="callout amber">{t("oracle.noDvm")}</p>}
      <div className="simple-row actions">
        <button type="button" className="secondary" disabled={!canDispute} onClick={() => void api.run(t("oracle.approveLabel"), (signer) => tokenOf(api.dep, signer).approve(api.dep.oracle.optimisticOracleV3, oracleAssertion!.bond))}>{t("oracle.approve")}</button>
        <button type="button" className="secondary" disabled={!canDispute} onClick={() => void dispute()}>{t("oracle.dispute")}</button>
        <button type="button" className="primary accent" disabled={!canSettle} onClick={() => void settle()} data-testid="settle">{t("oracle.settle")}</button>
      </div>
      {local && market.assertion.disputed && <div className="mock-box">
        <p>{t("oracle.mockNote")}</p>
        <div className="simple-row actions">
          <button type="button" className="secondary" disabled={!canSimulate} onClick={() => void api.run(t("oracle.simTrueLabel"), (signer) => mockOracleOf(api.dep, signer).simulateDvmResolution(assertionId, true))}>{t("oracle.simTrue")}</button>
          <button type="button" className="secondary" disabled={!canSimulate} onClick={() => void api.run(t("oracle.simFalseLabel"), (signer) => mockOracleOf(api.dep, signer).simulateDvmResolution(assertionId, false))}>{t("oracle.simFalse")}</button>
        </div>
        {market.mockResolutionReady && <p>{market.mockResolution ? t("oracle.simReadyTrue") : t("oracle.simReadyFalse")}</p>}
      </div>}
    </section>}

    {show("time") && local && (custom || kind === "sports") && <section className="card oracle-section">
      <h3>{t("time.title")}</h3>
      <p className="subtext">{t("time.note")}</p>
      <div className="simple-row actions">
        {([
          [t("time.toOpen"), times.openAt], [t("time.toResult"), times.earliestAssertionAt], [t("time.toRefund"), times.refundAt],
        ] as const).map(([label, time]) => <button type="button" className="secondary" key={label}
          disabled={!api.ready || api.busy || now >= Number(time)} onClick={() => void api.advanceTo(Number(time))}>{label}</button>)}
        {oracleAssertion && <button type="button" className="secondary" disabled={!api.ready || api.busy || now > Number(oracleAssertion.expirationTime)}
          onClick={() => void api.advanceTo(Number(oracleAssertion.expirationTime) + 1)}>{t("time.pastDispute")}</button>}
      </div>
    </section>}
  </div>;
}
