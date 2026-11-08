import { useMemo, useState } from "react";
import { encodeBytes32String, getAddress, keccak256, toUtf8Bytes, type JsonRpcSigner } from "ethers";
import { formatFixed100, parseFixed100 } from "@shared/metric/fixed100";
import {
  HKO_DAILY_EXTRACT_FIELDS, HKO_FIELD_SOURCE_NAME, MAX_CUSTOM_METRIC_DOCUMENT_BYTES, buildCustomNumericRules,
  buildHkoFieldNumericRules, customMetricRulesDocument, findMetricRulesDocument, identifierFromText, isSourceUrl,
  type CustomMetric,
} from "@shared/metric/custom-profile";
import {
  MARKET_TIME_KEYS, hkDayMarketTimes, marketTimeProblems, windowMarketTimes, type MarketTimeProblem, type MarketTimes,
} from "@shared/metric/market-times";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules, buildSportsNumericRules } from "@shared/metric/numeric-profiles";
import { MIN_ASSERTION_LIVENESS, parseNumericMarketRules, type NumericRulesContext } from "@shared/metric/numeric-rules";
import { Icon } from "../components/Icon";
import { MetricMark } from "../components/MetricMark";
import { type MessageKey, t } from "../i18n";
import { type MarketData, type QuestionInput, conditionWithUnitOf, metricNameOf, questionOf, unitOf } from "../lib/markets";
import { href } from "../lib/routes";
import { formatHktMinute } from "../lib/time";
import { marketOf } from "./client";
import { downloadText, useMetricApp } from "./context";
import { Field, identityOf, metricDocKey, pendingTimestamp, thresholdProblem, useContextGuard } from "./form-parts";
import {
  DEMO_MATCHES, type ConditionInput, type MatchInput, type MetricChoice, type TimingInput, defaultCondition, definitionOf,
  metricChoices, nextOpenDay, registrationOf, rulesHashOf, templateOf,
} from "./new-market-model";

const HOUR = 3_600;
const HKT = 8 * HOUR;
type TimeKey = Exclude<(typeof MARKET_TIME_KEYS)[number], "assertionLiveness">;
const EDITABLE_TIMES = MARKET_TIME_KEYS.filter((key): key is TimeKey => key !== "assertionLiveness");
const TIME_LABELS: Record<TimeKey, MessageKey> = {
  openAt: "rule.open", closeAt: "rule.close", observationStart: "custom.observationStart", observationEnd: "custom.observationEnd",
  earliestAssertionAt: "rule.earliest", proposalCutoff: "rule.cutoff", refundAt: "rule.refundAt",
};
const WINDOW_PROBLEMS: readonly MarketTimeProblem[] = ["NOT_WHOLE_SECONDS", "OPENS_IN_PAST", "CLOSES_BEFORE_OPEN", "OBSERVES_BEFORE_CLOSE", "EMPTY_OBSERVATION"];
const MAX_TITLE_BYTES = 240;

export function toHktInput(unix: number): string {
  return new Date((unix + HKT) * 1000).toISOString().slice(0, 16);
}
export function fromHktInput(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return Number.NaN;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute) / 1000 - HKT;
}

function identifierProblem(value: string, name: string): string | null {
  const text = value.trim();
  // eslint-disable-next-line no-control-regex -- Codes and units must not hide control characters.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text) || toUtf8Bytes(text).length > 31) return t("form.identifier", { name });
  return null;
}

type NewMetricField = "code" | "unit" | "min" | "max" | "step" | "definition" | "range";
interface NewMetricInput { code: string; unit: string; min: string; max: string; step: string; definition: string; trace: boolean }

function parseNewMetric(input: NewMetricInput, submitted: boolean): { metric: CustomMetric | null; errors: Partial<Record<NewMetricField, string>> } {
  const errors: Partial<Record<NewMetricField, string>> = {};
  const code = input.code.trim();
  const unit = input.unit.trim();
  const codeProblem = code ? identifierProblem(code, t("registry.code")) : submitted ? t("new.needCode") : null;
  if (codeProblem) errors.code = codeProblem;
  const unitProblem = unit ? identifierProblem(unit, t("registry.unit")) : submitted ? t("new.needUnit") : null;
  if (unitProblem) errors.unit = unitProblem;
  const number = (text: string, field: "min" | "max") => {
    try {
      return parseFixed100(text);
    } catch {
      errors[field] = t("create.thresholdInvalid"); // parseFixed100 accepts only a plain decimal with up to two places.
      return 0;
    }
  };
  const minValue = number(input.min, "min");
  const maxValue = number(input.max, "max");
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(input.step.trim());
  const valueStep = match ? Number(BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))) : 0;
  if (!match || valueStep <= 0) errors.step = t("form.stepFormat");
  else if (valueStep > 4_294_967_295) errors.step = t("form.stepRange");
  const definition = input.definition.trim();
  if (!definition && submitted) errors.definition = t("registry.needDefinition");
  if (Object.keys(errors).length > 0 || !code || !unit || !definition) return { metric: null, errors };
  try {
    return {
      metric: customMetricRulesDocument({ code, unit, minValue, maxValue, valueStep, allowsTrace: unit === "mm" && input.trace, interpretation: definition }),
      errors,
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/exceed/.test(text)) errors.definition = t("registry.tooLong", { bytes: MAX_CUSTOM_METRIC_DOCUMENT_BYTES });
    else errors.range = /TRACE/.test(text) ? t("registry.traceRange") : t("registry.rangeStep");
    return { metric: null, errors };
  }
}

const codeOf = (choice: MetricChoice, newCode: string) => (choice.kind === "new" ? newCode.trim() : definitionOf(choice)!.code);
function guessDefinition(input: NewMetricInput) {
  const value = (text: string, fallback: number) => {
    try {
      return parseFixed100(text);
    } catch {
      return fallback; // The field is unfinished. The metric step shows its own error.
    }
  };
  return { code: "", unit: input.unit.trim(), minValue: value(input.min, -100_000), maxValue: value(input.max, 100_000), valueStep: Math.max(1, value(input.step, 1)), allowsTrace: false };
}
function choiceName(choice: MetricChoice): string {
  if (choice.kind === "new") return t("new.newMetric");
  if (choice.kind === "field") return t(`field.${choice.field.key}` as MessageKey);
  return metricNameOf(definitionOf(choice)!.code);
}

type WindowMode = "day" | "window";
const quarterAfter = (unix: number) => Math.ceil(unix / 900) * 900;

export function NewMarket({ template }: { template?: MarketData }) {
  const api = useMetricApp();
  const sepolia = api.dep.environment === "SEPOLIA_UMA";
  const local = api.dep.environment === "LOCAL_MOCK" && api.dep.chainId === 31337;
  const openDelay = sepolia ? 300 : 60;
  const minimumLiveness = sepolia ? 7200 : MIN_ASSERTION_LIVENESS;
  const [initialTime] = useState(() => Math.floor(Date.now() / 1000));
  const now = api.data?.now ?? initialTime;
  const registered = useMemo(() => api.data?.metrics ?? [], [api.data?.metrics]);
  const choices = metricChoices(registered, local);
  const [initial] = useState(() => template ? templateOf(template, now, openDelay) : null);
  const [choiceKey, setChoiceKey] = useState(initial?.choiceKey ?? choices[0]!.key);
  const choice = choices.find((item) => item.key === choiceKey) ?? choices[0]!;
  const [newMetric, setNewMetric] = useState<NewMetricInput>({ code: "", unit: "degC", min: "-10.0", max: "50.0", step: "0.1", definition: "", trace: false });
  const [condition, setCondition] = useState<ConditionInput>(() => initial?.condition ?? defaultCondition(definitionOf(choices[0]!)));
  const [source, setSource] = useState(initial?.source ?? { name: "", url: "", procedure: "" });
  const [match, setMatch] = useState<MatchInput>(initial?.match ?? DEMO_MATCHES.BASKETBALL);
  const [mode, setMode] = useState<WindowMode>(initial?.window.mode ?? "day");
  // Null means the default. Defaults follow the chain's clock. A local chain can run ahead of the wall clock.
  const [dateInput, setDate] = useState<string | null>(initial?.window.mode === "day" ? initial.window.date : null);
  const [startInput, setStart] = useState<string | null>(initial?.window.mode === "window" ? toHktInput(initial.window.start) : null);
  const [endInput, setEnd] = useState<string | null>(initial?.window.mode === "window" ? toHktInput(initial.window.end) : null);
  const firstStart = quarterAfter(now + 30 * 60);
  const date = dateInput ?? nextOpenDay(now, openDelay);
  const start = startInput ?? toHktInput(firstStart);
  const end = endInput ?? toHktInput(firstStart + HOUR);
  const [timing, setTiming] = useState<TimingInput>(() => initial?.timing
    ?? (sepolia ? { proposalHours: "168", liveness: "7200", bufferHours: "24" } : { proposalHours: "24", liveness: "120", bufferHours: "1" }));
  const [overrides, setOverrides] = useState<Partial<Record<TimeKey, string>>>({});
  const [title, setTitle] = useState("");
  const [proposer, setProposer] = useState("");
  const [importedRules, setImportedRules] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [created, setCreated] = useState<{ id: number; key: string } | null>(null);
  const [lastRules, setLastRules] = useState<{ key: string; document: string } | null>(null);

  const parsedNew = choice.kind === "new" ? parseNewMetric(newMetric, submitted) : { metric: null, errors: {} };
  const definition = choice.kind === "new" ? parsedNew.metric?.definition : definitionOf(choice);
  const field = choice.kind === "field" ? choice.field : undefined;
  const sports = choice.kind === "sports" ? choice : undefined;
  const dayOnly = choice.kind === "official" || !!field;
  const dayMode = dayOnly || (!sports && mode === "day");
  const needsSource = !dayOnly && !sports;
  const code = codeOf(choice, newMetric.code);
  const newHash = parsedNew.metric?.rulesHash;
  const registration = registrationOf(choice, registered, { code: newMetric.code, ...(newHash ? { rulesHash: newHash } : {}) });
  const needsRegistration = registration.state === "missing";
  const metricLabel = choice.kind === "new" ? code : choiceName(choice);

  const markets = api.data?.markets;
  const embeddedRules = useMemo(() => {
    const documents = new Set<string>();
    for (const market of markets ?? []) {
      try {
        documents.add(parseNumericMarketRules(market.rulesDocument).metric.rulesDocument);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    return [...documents];
  }, [markets]);
  let metricRules: string | undefined;
  if (choice.kind === "official" || choice.kind === "sports") metricRules = choice.preset.rulesDocument;
  else if (choice.kind === "field") metricRules = choice.field.metric.rulesDocument;
  else if (choice.kind === "new") metricRules = parsedNew.metric?.rulesDocument;
  else {
    let saved: string | null = null;
    try {
      saved = globalThis.localStorage?.getItem(metricDocKey(api.dep.contracts.PredictionMarket.address, choice.metric.rulesHash)) ?? null;
    } catch (error) {
      // Storage is blocked. The creator can import the rules file instead.
      if (!(error instanceof Error)) throw error;
    }
    metricRules = findMetricRulesDocument(choice.metric, [
      ...HKO_DAILY_EXTRACT_FIELDS.map((entry) => entry.metric.rulesDocument), ...NUMERIC_METRIC_PRESETS.map((preset) => preset.rulesDocument),
      ...embeddedRules, ...(saved ? [saved] : []), ...(importedRules ? [importedRules] : []),
    ]);
  }

  const plan = () => ({
    proposalWindow: Math.round(Number(timing.proposalHours) * HOUR), assertionLiveness: Number(timing.liveness), refundBuffer: Math.round(Number(timing.bufferHours) * HOUR),
  });
  const timesFor = (openAt: number): MarketTimes => {
    const base = dayMode
      ? hkDayMarketTimes({ openAt, targetDate: date.replaceAll("-", ""), plan: plan() })
      : windowMarketTimes({ openAt, observationStart: fromHktInput(start), observationEnd: fromHktInput(end), plan: plan() });
    const result = { ...base };
    for (const key of EDITABLE_TIMES) {
      const text = overrides[key]?.trim();
      if (text) result[key] = fromHktInput(text);
    }
    return result;
  };
  let preview: MarketTimes | undefined;
  let timeProblems: MarketTimeProblem[];
  try {
    preview = timesFor(now + openDelay);
    timeProblems = marketTimeProblems(preview, now);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    timeProblems = ["NOT_WHOLE_SECONDS"];
  }

  const errors = {
    metric: registration.state === "conflict" ? t("new.codeTaken", { code }) : null,
    rules: choice.kind === "registered" && !metricRules ? t("custom.rulesMissing", { code }) : null,
    condition: thresholdProblem(definition, condition.comparison, condition.lower, condition.upper),
    sourceName: needsSource && submitted && !source.name.trim() ? t("new.needSourceName") : null,
    sourceUrl: needsSource && source.url.trim() && !isSourceUrl(source.url.trim()) ? t("custom.badUrl")
      : needsSource && submitted && !source.url.trim() ? t("new.needSourceUrl") : null,
    procedure: needsSource && submitted && !source.procedure.trim() ? t("new.needProcedure") : null,
    matchId: !sports ? null : match.matchId.trim() ? identifierProblem(match.matchId, t("new.matchId")) : submitted ? t("new.needMatch") : null,
    teams: !sports ? null : !match.teamA.trim() || !match.teamB.trim() ? (submitted ? t("new.needTeams") : null)
      : match.teamA.trim() === match.teamB.trim() ? t("new.sameTeams") : null,
    window: timeProblems.filter((problem) => WINDOW_PROBLEMS.includes(problem)).map((problem) => t(`time.problem.${problem}` as MessageKey))[0] ?? null,
    timing: timeProblems.filter((problem) => !WINDOW_PROBLEMS.includes(problem)).map((problem) => t(`time.problem.${problem}` as MessageKey)),
    liveness: Number.isSafeInteger(Number(timing.liveness)) && Number(timing.liveness) >= minimumLiveness ? null : t("create.livenessMin", { n: minimumLiveness }),
    title: toUtf8Bytes(title.trim()).length > MAX_TITLE_BYTES ? t("new.titleTooLong", { bytes: MAX_TITLE_BYTES }) : null,
    ...parsedNew.errors,
  };
  const blocking = Object.values(errors).some((value) => Array.isArray(value) ? value.length > 0 : !!value)
    || (choice.kind === "new" && submitted && !parsedNew.metric);
  const advancedProblem = errors.timing.length > 0 || !!errors.liveness || !!errors.title;
  const incomplete = !definition || !metricRules || (needsSource && (!source.name.trim() || !source.url.trim() || !source.procedure.trim()))
    || (!!sports && (!match.matchId.trim() || !match.teamA.trim() || !match.teamB.trim()));

  const key = JSON.stringify([
    ...identityOf(api), choiceKey, newMetric, condition, source, match, mode, dateInput, startInput, endInput, timing, overrides, title, proposer, importedRules,
  ]);
  const assertCurrent = useContextGuard(key);

  const pick = (next: MetricChoice) => {
    setChoiceKey(next.key);
    setCreated(null);
    setSubmitted(false);
    setCondition(defaultCondition(next.kind === "new" ? guessDefinition(newMetric) : definitionOf(next)));
    if (next.kind === "sports") setMatch(DEMO_MATCHES[next.sport]);
  };
  const setTime = (name: TimeKey, value: string) => setOverrides((current) => ({ ...current, [name]: value }));

  const register = (signer: JsonRpcSigner) => {
    assertCurrent();
    const document = metricRules;
    const d = definition;
    const hash = choice.kind === "new" ? newHash : rulesHashOf(choice);
    if (!document || !d || !hash) throw new Error(t("new.needMetric"));
    if (choice.kind === "new") {
      try {
        localStorage.setItem(metricDocKey(api.dep.contracts.PredictionMarket.address, hash), document);
      } catch (error) {
        // Storage is blocked or full. The downloaded file still holds the rules. This form can import it.
        if (!(error instanceof Error)) throw error;
      }
      downloadText(`${d.code}-rules.json`, document);
    }
    return marketOf(api.dep, signer).registerMetric({
      code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), minValue: d.minValue, maxValue: d.maxValue,
      valueStep: d.valueStep, allowsTrace: d.allowsTrace, rulesHash: hash,
    });
  };

  const createOn = async (signer: JsonRpcSigner, expected: { id: number; hash: string }) => {
    if (!definition || !metricRules) throw new Error(t("new.needMetric"));
    if (sports && !local) throw new Error(t("new.demoLocalOnly"));
    const block = await api.reader.getBlock("latest");
    assertCurrent();
    if (!block || !Number.isSafeInteger(block.timestamp) || block.timestamp < 0) throw new Error(t("create.noTimestamp"));
    const reader = marketOf(api.dep, api.reader);
    const metricId = Number(await reader.metricIdByCode(encodeBytes32String(definition.code), { blockTag: block.number }));
    if (!metricId) throw new Error(t("new.notRegistered", { code: definition.code }));
    const [chainMetric, signerAddress, pending, count] = await Promise.all([
      reader.getMetric(metricId, { blockTag: block.number }),
      proposer.trim() ? Promise.resolve(proposer.trim()) : signer.getAddress(),
      // Idle local chains may advance to wall-clock time. Raw RPC accepts pending.number=null.
      api.reader.send("eth_getBlockByNumber", ["pending", false]),
      reader.marketCount({ blockTag: block.number }),
    ]);
    assertCurrent();
    const chainNow = Math.max(block.timestamp, pendingTimestamp(pending));
    const hash = choice.kind === "new" ? newHash : rulesHashOf(choice);
    if (!hash || chainMetric.rulesHash.toLowerCase() !== hash.toLowerCase()
      || chainMetric.code.toLowerCase() !== encodeBytes32String(definition.code).toLowerCase()) throw new Error(t("create.metricMismatch"));
    if (errors.condition) throw new Error(errors.condition);
    if (errors.liveness) throw new Error(errors.liveness);
    const times = timesFor(chainNow + openDelay);
    const [timeProblem] = marketTimeProblems(times, chainNow);
    if (timeProblem) throw new Error(t(`time.problem.${timeProblem}` as MessageKey));
    const config = {
      proposer: getAddress(signerAddress),
      sourceId: encodeBytes32String(sports ? `DEMO_${sports.sport}` : dayOnly ? "HKO_DAILY_EXTRACT" : identifierFromText(source.name.trim(), "CUSTOM_SOURCE")),
      subjectId: encodeBytes32String(sports ? match.matchId.trim() : dayOnly ? "HKO" : definition.code),
      condition: {
        metricId, comparison: Number(condition.comparison), lower: parseFixed100(condition.lower),
        upper: condition.comparison === "5" ? parseFixed100(condition.upper) : 0,
      },
      times,
    };
    const targetDate = date.replaceAll("-", "");
    const marketTitle = title.trim() || autoTitle();
    const context: NumericRulesContext = { config, metricId, metric: chainMetric };
    // The rules and the transaction bind the same fresh config. No result exists yet.
    const rules = choice.kind === "official" ? buildHkoNumericRules({ title: marketTitle, targetDate }, context)
      : field ? buildHkoFieldNumericRules({ title: marketTitle, targetDate }, context)
        : sports ? buildSportsNumericRules({ title: marketTitle, sport: sports.sport, matchId: match.matchId.trim(), teamA: match.teamA.trim(), teamB: match.teamB.trim() }, context)
          : buildCustomNumericRules({ title: marketTitle, sourceName: source.name.trim(), sourceUrl: source.url.trim(), procedure: source.procedure.trim(), metricRulesDocument: metricRules }, context);
    assertCurrent();
    setLastRules({ key, document: rules });
    expected.id = Number(count) + 1;
    expected.hash = keccak256(toUtf8Bytes(rules));
    return marketOf(api.dep, signer).createMarket(config, toUtf8Bytes(rules));
  };

  function autoTitle(): string {
    const d = definition!;
    const conditionText = condition.comparison === "5"
      ? `between ${condition.lower.trim()} and ${condition.upper.trim()} ${d.unit} inclusive`
      : `${["", "<", "≤", ">", "≥"][Number(condition.comparison)] ?? ""} ${condition.lower.trim()} ${d.unit}`;
    const prefix = sports ? `DEMO ${match.matchId.trim()} ${match.teamA.trim()} vs ${match.teamB.trim()}, ` : "";
    return `${prefix}${d.code} ${conditionText}, ${dayMode ? date : `${start} to ${end} HKT`}`;
  }

  const create = async () => {
    setSubmitted(true);
    setCreated(null);
    setLastRules(null);
    if (blocking || incomplete) return;
    if (needsRegistration) {
      const registeredOk = await api.run(t("new.stepRegister", { name: metricLabel }), register);
      if (!registeredOk) return;
    }
    const expected = { id: 0, hash: "" };
    const ok = await api.run(needsRegistration ? t("new.stepCreate") : t("create.label"), (signer) => createOn(signer, expected));
    if (!ok || !expected.id) return;
    try {
      const reader = marketOf(api.dep, api.reader);
      const count = Number(await reader.marketCount());
      for (let id = expected.id; id <= count; id++) {
        if ((await reader.marketRulesHash(id)).toLowerCase() === expected.hash.toLowerCase()) {
          setCreated({ id, key });
          return;
        }
      }
    } catch (error) {
      // The market exists either way. Without the read the page shows no link. The market list still has it.
      if (!(error instanceof Error)) throw error;
    }
  };

  const unit = definition ? unitOf(definition.unit) : "";
  const range = condition.comparison === "5";
  const weatherChoices = choices.filter((item) => item.kind !== "sports");
  const demoChoices = choices.filter((item) => item.kind === "sports");
  const card = (item: MetricChoice) => {
    const state = item.kind === "new" ? null : registrationOf(item, registered);
    const itemCode = item.kind === "new" ? "" : definitionOf(item)!.code;
    const tag = item.kind === "official" ? "official" : item.kind === "sports" ? "demo" : "custom";
    return <button key={item.key} type="button" role="radio" aria-checked={item.key === choice.key} className={`metric-card ${item.key === choice.key ? "active" : ""}`}
      onClick={() => pick(item)} data-testid={`choice-${item.key}`}>
      {item.kind === "new" ? <span className="metric-mark small" data-metric="custom" aria-hidden="true"><Icon name="sliders" /></span> : <MetricMark code={itemCode} small />}
      <span className="metric-card-name">{choiceName(item)}</span>
      <small className="metric-card-state">
        {item.kind !== "new" && <span className={`badge-tag badge-${tag}`}>{t(`market.${tag}Tag` as MessageKey)}</span>}
        {item.kind === "new" ? t("new.newMetricNote") : state?.state === "registered" ? t("new.registeredAs", { id: state.metric.id }) : state?.state === "missing" ? t("new.registersFirst") : t("new.codeInUse")}
      </small>
    </button>;
  };
  const previewSubject: QuestionInput["subject"] | null = choice.kind === "official" ? { kind: "HKO", targetDate: date.replaceAll("-", "") }
    : field ? { kind: "CUSTOM", sourceName: HKO_FIELD_SOURCE_NAME, sourceUrl: "", procedure: "", targetDate: date.replaceAll("-", "") }
      : sports ? { kind: "SYNTHETIC", sport: sports.sport, matchId: match.matchId.trim(), teamA: match.teamA.trim(), teamB: match.teamB.trim() }
        : { kind: "CUSTOM", sourceName: source.name, sourceUrl: source.url, procedure: source.procedure, targetDate: null };
  let previewQuestion: QuestionInput | null = null;
  if (definition && preview && !errors.condition && previewSubject && MARKET_TIME_KEYS.every((name) => Number.isSafeInteger(preview![name]))) {
    const big = (name: keyof MarketTimes) => BigInt(preview![name]);
    const times = {
      openAt: big("openAt"), closeAt: big("closeAt"), observationStart: big("observationStart"), observationEnd: big("observationEnd"),
      earliestAssertionAt: big("earliestAssertionAt"), proposalCutoff: big("proposalCutoff"), refundAt: big("refundAt"), assertionLiveness: big("assertionLiveness"),
    };
    previewQuestion = {
      subject: previewSubject, times,
      metric: { id: 0, code: definition.code, unit: definition.unit, valueStep: definition.valueStep, allowsTrace: definition.allowsTrace },
      condition: { comparison: Number(condition.comparison), lower: BigInt(parseFixed100(condition.lower)), upper: range ? BigInt(parseFixed100(condition.upper)) : 0n },
    };
  }

  return <section className="card ops-section new-market" aria-labelledby="new-market-title" data-testid="create-market">
    <h2 id="new-market-title">{t("new.title")}</h2>
    <p className="subtext">{t("new.sub")}</p>
    <form onSubmit={(event) => { event.preventDefault(); void create(); }} data-testid="new-market-form" noValidate>
      <fieldset disabled={api.busy} className="plain-fieldset">
        <h3 className="ops-subtitle">{t("new.stepMetric")}</h3>
        <div role="radiogroup" aria-label={t("new.stepMetric")}>
          <div className="metric-cards">{weatherChoices.map(card)}</div>
          {demoChoices.length > 0 && <>
            <p className="metric-group-label" data-testid="demo-choices"><strong>{t("new.demoGroup")}</strong> {t("new.demoGroupNote")}</p>
            <div className="metric-cards">{demoChoices.map(card)}</div>
          </>}
        </div>
        {errors.metric && <p className="input-note error" role="alert" data-testid="metric-error">{errors.metric}</p>}
        {choice.kind === "registered" && !metricRules && <div className="input-note" data-testid="custom-rules-missing">
          <p className="input-note error" role="alert">{errors.rules}</p>
          <input type="file" accept=".json,application/json,text/plain" aria-label={t("custom.importRules")}
            onChange={(event) => void event.target.files?.[0]?.arrayBuffer().then((bytes) => setImportedRules(new TextDecoder().decode(bytes)))} />
        </div>}
        {field && <p className="fine-print" data-testid="custom-field-source">{t("custom.fieldSource", { name: metricNameOf(field.metric.definition.code), column: field.column, header: field.header })}</p>}

        {choice.kind === "new" && <div className="form-grid" data-testid="new-metric">
          <Field title={t("registry.code")} error={errors.code}><input value={newMetric.code} placeholder="AFTERNOON_TEMPERATURE" onChange={(event) => setNewMetric({ ...newMetric, code: event.target.value })} /></Field>
          <Field title={t("registry.unit")} error={errors.unit}><input value={newMetric.unit} onChange={(event) => setNewMetric({ ...newMetric, unit: event.target.value })} /></Field>
          <Field title={t("registry.min")} error={errors.min}><input value={newMetric.min} onChange={(event) => setNewMetric({ ...newMetric, min: event.target.value })} /></Field>
          <Field title={t("registry.max")} error={errors.max ?? errors.range}><input value={newMetric.max} onChange={(event) => setNewMetric({ ...newMetric, max: event.target.value })} /></Field>
          <Field title={t("registry.step")} error={errors.step}><input value={newMetric.step} onChange={(event) => setNewMetric({ ...newMetric, step: event.target.value })} /></Field>
        </div>}
        {choice.kind === "new" && <Field title={t("registry.definition")} error={errors.definition}>
          <textarea value={newMetric.definition} placeholder={t("new.definitionPlaceholder")} onChange={(event) => setNewMetric({ ...newMetric, definition: event.target.value })} />
        </Field>}
        {choice.kind === "new" && newMetric.unit.trim() === "mm" && <label className="check-row">
          <input type="checkbox" checked={newMetric.trace} onChange={(event) => setNewMetric({ ...newMetric, trace: event.target.checked })} /> {t("registry.allowTrace")}
        </label>}

        <h3 className="ops-subtitle">{t("new.stepCondition")}</h3>
        <div className="form-grid">
          <Field title={t("create.comparison")}><select value={condition.comparison} onChange={(event) => setCondition({ ...condition, comparison: event.target.value })}>
            <option value="4">{t("create.gte")}</option><option value="3">{t("create.gt")}</option>
            <option value="2">{t("create.lte")}</option><option value="1">{t("create.lt")}</option>
            <option value="5">{t("create.range")}</option>
          </select></Field>
          <Field title={range ? t("create.lower") : t("create.threshold")} error={errors.condition} testId="threshold-error">
            <input value={condition.lower} inputMode="decimal" onChange={(event) => setCondition({ ...condition, lower: event.target.value })} />
          </Field>
          {range && <Field title={t("create.upper")}><input value={condition.upper} inputMode="decimal" onChange={(event) => setCondition({ ...condition, upper: event.target.value })} /></Field>}
        </div>
        {definition && <p className="fine-print">{t("create.thresholdHint", { min: formatFixed100(definition.minValue), max: formatFixed100(definition.maxValue), step: formatFixed100(definition.valueStep), unit })}{range ? ` ${t("custom.rangeInclusive")}` : ""}</p>}

        {sports && <>
          <h3 className="ops-subtitle">{t("new.stepMatch")}</h3>
          <div className="form-grid">
            <Field title={t("new.matchId")} error={errors.matchId}><input value={match.matchId} onChange={(event) => setMatch({ ...match, matchId: event.target.value })} data-testid="match-id" /></Field>
            <Field title={t("new.teamA")} error={errors.teams}><input value={match.teamA} onChange={(event) => setMatch({ ...match, teamA: event.target.value })} data-testid="match-team-a" /></Field>
            <Field title={t("new.teamB")}><input value={match.teamB} onChange={(event) => setMatch({ ...match, teamB: event.target.value })} data-testid="match-team-b" /></Field>
          </div>
          <p className="fine-print" data-testid="match-note">{t("new.matchNote", { scope: t(sports.sport === "BASKETBALL" ? "rule.scopeBasketball" : "rule.scopeFootball") })}</p>
        </>}

        {needsSource && <>
          <h3 className="ops-subtitle">{t("custom.sourceTitle")}</h3>
          <div className="form-grid">
            <Field title={t("custom.sourceName")} error={errors.sourceName}><input value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} placeholder={t("custom.sourceNamePlaceholder")} data-testid="custom-source-name" /></Field>
            <Field title={t("custom.sourceUrl")} error={errors.sourceUrl}><input value={source.url} onChange={(event) => setSource({ ...source, url: event.target.value })} placeholder="https://data.weather.gov.hk/…" data-testid="custom-source-url-input" /></Field>
          </div>
          <Field title={t("custom.procedure")} error={errors.procedure}><textarea value={source.procedure} onChange={(event) => setSource({ ...source, procedure: event.target.value })} placeholder={t("custom.procedurePlaceholder")} data-testid="custom-procedure-input" /></Field>
        </>}

        <h3 className="ops-subtitle">{t("new.stepDay")}</h3>
        <div className="form-grid">
          {needsSource && <Field title={t("custom.windowMode")}><select value={mode} onChange={(event) => setMode(event.target.value as WindowMode)} data-testid="custom-window-mode">
            <option value="day">{t("custom.windowDay")}</option>
            <option value="window">{t("custom.windowCustom")}</option>
          </select></Field>}
          {dayMode
            ? <Field title={t("create.date")} error={errors.window}><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></Field>
            : <>
              <Field title={t("custom.observationStart")} error={errors.window}><input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} data-testid="custom-start" /></Field>
              <Field title={t("custom.observationEnd")}><input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} data-testid="custom-end" /></Field>
            </>}
        </div>
        <details className="ops-details" data-testid="custom-times">
          <summary>{t("new.advanced")}{advancedProblem && <span className="input-note error" data-testid="advanced-problem">{t("new.advancedProblem")}</span>}</summary>
          <div className="form-grid">
            <Field title={t("custom.proposalHours")}><input type="number" min="0" step="any" value={timing.proposalHours} onChange={(event) => setTiming({ ...timing, proposalHours: event.target.value })} /></Field>
            <Field title={t("create.liveness")} error={errors.liveness}><input type="number" min={minimumLiveness} step="1" value={timing.liveness} onChange={(event) => setTiming({ ...timing, liveness: event.target.value })} /></Field>
            <Field title={t("custom.bufferHours")}><input type="number" min="1" step="any" value={timing.bufferHours} onChange={(event) => setTiming({ ...timing, bufferHours: event.target.value })} /></Field>
          </div>
          <p className="fine-print">{t("custom.timesNote")}</p>
          <div className="form-grid">{EDITABLE_TIMES.map((name) => <Field key={name} title={t(TIME_LABELS[name])}>
            <input type="datetime-local" value={overrides[name] ?? (preview && Number.isFinite(preview[name]) ? toHktInput(preview[name]) : "")}
              onChange={(event) => setTime(name, event.target.value)} data-testid={`custom-time-${name}`} />
          </Field>)}</div>
          {errors.timing.map((text) => <p key={text} className="input-note error" role="alert" data-testid="timing-error">{text}</p>)}
          <div className="simple-row">
            <button type="button" className="secondary small-button" onClick={() => setOverrides({})}>{t("custom.timesReset")}</button>
          </div>
          <Field title={t("create.title2")} error={errors.title}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("create.titlePlaceholder")} /></Field>
          <Field title={t("create.proposer")}><input value={proposer} onChange={(event) => setProposer(event.target.value)} placeholder={api.wallet.account ?? "0x…"} /></Field>
          <p className="fine-print">{t("create.proposerNote")}</p>
        </details>

        <h3 className="ops-subtitle">{t("new.stepPreview")}</h3>
        <dl className="review-list new-preview" data-testid="new-preview">
          <dt>{t("new.question")}</dt><dd data-testid="preview-question">{previewQuestion ? questionOf(previewQuestion) : "—"}</dd>
          <dt>{t("new.yes")}</dt><dd>{previewQuestion ? t("new.yesValue", { cond: conditionWithUnitOf(previewQuestion), gap: /^[\u3400-\u9fff]/.test(conditionWithUnitOf(previewQuestion)) ? "" : " " }) : "—"}</dd>
          <dt>{t("rule.close")}</dt><dd>{preview && Number.isSafeInteger(preview.closeAt) ? formatHktMinute(BigInt(preview.closeAt)) : "—"}</dd>
          <dt>{t("new.observation")}</dt><dd>{preview && Number.isSafeInteger(preview.observationStart) && Number.isSafeInteger(preview.observationEnd)
            ? t("rule.dateWindow", { from: formatHktMinute(BigInt(preview.observationStart)), to: formatHktMinute(BigInt(preview.observationEnd)) }) : "—"}</dd>
          <dt>{t("new.firstResult")}</dt><dd>{preview && Number.isSafeInteger(preview.earliestAssertionAt) ? formatHktMinute(BigInt(preview.earliestAssertionAt)) : "—"}</dd>
          <dt>{t("rule.refundAt")}</dt><dd>{preview && Number.isSafeInteger(preview.refundAt) ? formatHktMinute(BigInt(preview.refundAt)) : "—"}<small className="muted"> {t("new.refundValue")}</small></dd>
        </dl>
        {sepolia && <p className="fine-print">{t("create.sepoliaNote")}</p>}
        {created?.key === key && <p className="input-note ok new-created" role="status" data-testid="new-created">
          {t("new.created", { id: created.id })} <a href={href.market(created.id)}>{t("new.open", { id: created.id })}</a>
        </p>}
        <div className="simple-row actions">
          <button className="primary accent" type="submit" disabled={!api.canWrite || !api.isAdmin || blocking} data-testid="custom-create">
            {needsRegistration ? t("new.submitTwo") : t("create.submit")}
          </button>
          {lastRules?.key === key && <button type="button" className="secondary" onClick={() => downloadText("market-rules.json", lastRules.document)}>{t("result.downloadRules")}</button>}
        </div>
        {needsRegistration && <p className="fine-print">{t("new.twoSteps", { name: metricLabel || "…" })}</p>}
        {!api.isAdmin && <p className="fine-print">{t("registry.adminOnly")}</p>}
      </fieldset>
    </form>
  </section>;
}
