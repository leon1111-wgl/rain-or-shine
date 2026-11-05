import { readFileSync } from "node:fs";
import { type Page, expect } from "@playwright/test";
import { Contract, JsonRpcProvider, encodeBytes32String, toUtf8Bytes, type InterfaceAbi } from "ethers";
import {
  HKO_DAILY_EXTRACT_FIELDS, buildCustomNumericRules, buildHkoFieldNumericRules, customMetricRulesDocument, identifierFromText, type CustomMetric,
} from "../../src/metric/custom-profile.js";
import { parseFixed100 } from "../../src/metric/fixed100.js";
import { windowMarketTimes } from "../../src/metric/market-times.js";
import { NUMERIC_METRIC_PRESETS, buildHkoNumericRules } from "../../src/metric/numeric-profiles.js";
import { hkDayWindow } from "../../src/weather/profile.js";

export const RPC = "http://127.0.0.1:8545";
export const provider = new JsonRpcProvider(RPC, 31337, { staticNetwork: true, cacheTimeout: -1 });
export const E = (milli: number): bigint => BigInt(milli) * 10n ** 15n;
export const ADMIN = 0;
export const PROPOSER = 1;
const LIVENESS = 120;

interface Manifest {
  contracts: Record<string, { address: string }>;
  oracle: { optimisticOracleV3: string; bondCurrency: string };
}

const manifest = () => JSON.parse(readFileSync("deployments/metric.localhost.json", "utf8")) as Manifest;
const abi = () => JSON.parse(readFileSync("web/src/generated/metric-abi.json", "utf8")) as Record<string, InterfaceAbi>;

export async function account(i: number): Promise<string> {
  const accounts = (await provider.send("eth_accounts", [])) as string[];
  return accounts[i]!;
}

export async function chain(i = 0) {
  const s = await provider.getSigner(i);
  const m = manifest();
  const a = abi();
  return {
    market: new Contract(m.contracts.PredictionMarket!.address, a.PredictionMarket!, s),
    oracle: new Contract(m.oracle.optimisticOracleV3, a.MockOptimisticOracleV3!, s),
    bond: new Contract(m.oracle.bondCurrency, a.TestBondToken!, s),
  };
}

export async function chainNow(): Promise<number> {
  await provider.send("evm_mine", []);
  return (await provider.getBlock("latest"))!.timestamp;
}

export async function travelTo(timestamp: number | bigint): Promise<void> {
  const now = await chainNow();
  if (Number(timestamp) > now) await provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await provider.send("evm_mine", []);
}

async function metricId(code: string): Promise<number> {
  const { market } = await chain(ADMIN);
  const count = Number(await market.getFunction("metricCount")());
  for (let id = 1; id <= count; id++) {
    const m = await market.getFunction("getMetric")(id);
    if (m.code === encodeBytes32String(code)) return id;
  }
  const p = NUMERIC_METRIC_PRESETS.find((preset) => preset.code === code)!;
  await (await market.getFunction("registerMetric")({ code: encodeBytes32String(p.code), unit: encodeBytes32String(p.unit), minValue: p.minValue, maxValue: p.maxValue, valueStep: p.valueStep, allowsTrace: p.allowsTrace, rulesHash: p.rulesHash })).wait();
  return Number(await market.getFunction("metricCount")());
}

export interface Created {
  id: number;
  times: { openAt: number; closeAt: number; observationEnd: number; earliestAssertionAt: number; refundAt: number };
}

async function create(config: { proposer: string; sourceId: string; subjectId: string; condition: object; times: Record<string, number> }, rules: string): Promise<Created> {
  const { market } = await chain(ADMIN);
  await (await market.getFunction("createMarket")(config, toUtf8Bytes(rules))).wait();
  const id = Number(await market.getFunction("marketCount")());
  const t = config.times;
  return { id, times: { openAt: t.openAt!, closeAt: t.closeAt!, observationEnd: t.observationEnd!, earliestAssertionAt: t.earliestAssertionAt!, refundAt: t.refundAt! } };
}

export const QUICK_METRIC = customMetricRulesDocument({
  code: "QUICK_TEMPERATURE", unit: "degC", minValue: -10_000, maxValue: 10_000, valueStep: 10, allowsTrace: false,
  interpretation: "Air temperature at HKO headquarters at the end of the observation window, in degrees Celsius.",
});
const QUICK_SOURCE = {
  sourceName: "HKO Current Weather Report", sourceUrl: "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en",
  procedure: "Read the HKO headquarters temperature from the first report at or after the end of the window.",
};

export async function createQuickMarket(minutes = 30): Promise<Created> {
  const { market } = await chain(ADMIN);
  let id = 0;
  const count = Number(await market.getFunction("metricCount")());
  for (let i = 1; i <= count; i++) {
    if ((await market.getFunction("getMetric")(i)).rulesHash === QUICK_METRIC.rulesHash) id = i;
  }
  if (id === 0) {
    const d = QUICK_METRIC.definition;
    await (await market.getFunction("registerMetric")({ ...d, code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), rulesHash: QUICK_METRIC.rulesHash })).wait();
    id = Number(await market.getFunction("metricCount")());
  }
  const openAt = (await chainNow()) + 60;
  const closeAt = openAt + minutes * 60;
  const config = {
    proposer: await account(PROPOSER), sourceId: encodeBytes32String("HKO_CURRENT_WEATHER"), subjectId: encodeBytes32String("QUICK_TEMPERATURE"),
    condition: { metricId: id, comparison: 4, lower: 2600, upper: 0 },
    times: { openAt, closeAt, observationStart: closeAt, observationEnd: closeAt + 60, earliestAssertionAt: closeAt + 60, proposalCutoff: closeAt + 3_660, refundAt: closeAt + 3_660 + LIVENESS + 3_600, assertionLiveness: LIVENESS }
  };
  const rules = buildCustomNumericRules({ title: "Temperature at least 26 degC", ...QUICK_SOURCE, metricRulesDocument: QUICK_METRIC.rulesDocument }, { config, metricId: id, metric: await market.getFunction("getMetric")(id) });
  const created = await create(config, rules);
  await travelTo(openAt);
  return created;
}

export async function createRainMarket(days = 3, threshold = "1.0"): Promise<Created> {
  return createOfficialMarket("TOTAL_RAINFALL", days, threshold);
}

export async function createOfficialMarket(code: "TOTAL_RAINFALL" | "DAILY_MAX_TEMPERATURE", days: number, threshold: string): Promise<Created> {
  const id = await metricId(code);
  const { market } = await chain(ADMIN);
  const now = await chainNow();
  const date = new Date((now + 8 * 3_600 + days * 86_400) * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const window = hkDayWindow(date);
  const end = Number(window.end);
  const config = {
    proposer: await account(PROPOSER), sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"), subjectId: encodeBytes32String("HKO"),
    condition: { metricId: id, comparison: 4, lower: parseFixed100(threshold), upper: 0 },
    times: { openAt: now + 60, closeAt: Number(window.start) - 60, observationStart: Number(window.start), observationEnd: end, earliestAssertionAt: end, proposalCutoff: end + 7 * 86_400, refundAt: end + 7 * 86_400 + LIVENESS + 3_600, assertionLiveness: LIVENESS },
  };
  const rules = buildHkoNumericRules({ title: `${date} ${code}`, targetDate: date }, { config, metricId: id, metric: await market.getFunction("getMetric")(id) });
  const created = await create(config, rules);
  await travelTo(now + 60);
  return created;
}

export async function createFieldMarket(key: string, days: number, lower: string, upper: string): Promise<Created> {
  const field = HKO_DAILY_EXTRACT_FIELDS.find((entry) => entry.key === key);
  if (!field) throw new Error(`no Daily Extract field ${key}`);
  const { market } = await chain(ADMIN);
  const d = field.metric.definition;
  let id = await registeredMetricId(d.code);
  if (!id) {
    await (await market.getFunction("registerMetric")({ code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), minValue: d.minValue, maxValue: d.maxValue, valueStep: d.valueStep, allowsTrace: d.allowsTrace, rulesHash: field.metric.rulesHash })).wait();
    id = Number(await market.getFunction("metricCount")());
  }
  const now = await chainNow();
  const date = new Date((now + 8 * 3_600 + days * 86_400) * 1000).toISOString().slice(0, 10).replaceAll("-", "");
  const window = hkDayWindow(date);
  const end = Number(window.end);
  const config = {
    proposer: await account(PROPOSER), sourceId: encodeBytes32String("HKO_DAILY_EXTRACT"), subjectId: encodeBytes32String("HKO"),
    condition: { metricId: id, comparison: 5, lower: parseFixed100(lower), upper: parseFixed100(upper) },
    times: { openAt: now + 60, closeAt: Number(window.start) - 60, observationStart: Number(window.start), observationEnd: end, earliestAssertionAt: end, proposalCutoff: end + 7 * 86_400, refundAt: end + 7 * 86_400 + LIVENESS + 3_600, assertionLiveness: LIVENESS },
  };
  const rules = buildHkoFieldNumericRules({ title: `${date} ${d.code}`, targetDate: date }, { config, metricId: id, metric: await market.getFunction("getMetric")(id) });
  const created = await create(config, rules);
  await travelTo(now + 60);
  return created;
}

export async function registeredMetricId(code: string): Promise<number> {
  const { market } = await chain(ADMIN);
  const count = Number(await market.getFunction("metricCount")());
  for (let id = 1; id <= count; id++) {
    if ((await market.getFunction("getMetric")(id)).code === encodeBytes32String(code)) return id;
  }
  return 0;
}

export interface CustomMarketSpec {
  metric: CustomMetric;
  comparison: number;
  lower: string;
  upper?: string;
  start: number;
  end: number;
  source: { sourceName: string; sourceUrl: string; procedure: string };
  title: string;
}

export async function createCustomMarket(spec: CustomMarketSpec): Promise<Created> {
  const { market } = await chain(ADMIN);
  let id = await registeredMetricId(spec.metric.definition.code);
  if (!id) {
    const d = spec.metric.definition;
    await (await market.getFunction("registerMetric")({ code: encodeBytes32String(d.code), unit: encodeBytes32String(d.unit), minValue: d.minValue, maxValue: d.maxValue, valueStep: d.valueStep, allowsTrace: d.allowsTrace, rulesHash: spec.metric.rulesHash })).wait();
    id = Number(await market.getFunction("metricCount")());
  }
  const now = await chainNow();
  const times = windowMarketTimes({ openAt: now + 60, observationStart: spec.start, observationEnd: spec.end, plan: { proposalWindow: 3_600, assertionLiveness: LIVENESS, refundBuffer: 3_600 } });
  const config = {
    proposer: await account(PROPOSER),
    sourceId: encodeBytes32String(identifierFromText(spec.source.sourceName, "CUSTOM_SOURCE")),
    subjectId: encodeBytes32String(spec.metric.definition.code),
    condition: { metricId: id, comparison: spec.comparison, lower: parseFixed100(spec.lower), upper: spec.upper ? parseFixed100(spec.upper) : 0 },
    times: { ...times },
  };
  const rules = buildCustomNumericRules({ title: spec.title, ...spec.source, metricRulesDocument: spec.metric.rulesDocument }, { config, metricId: id, metric: await market.getFunction("getMetric")(id) });
  const created = await create(config, rules);
  await travelTo(now + 60);
  return created;
}

export async function directBet(i: number, id: number, side: "YES" | "NO", wei: bigint): Promise<void> {
  const { market } = await chain(i);
  await (await market.getFunction("bet")(id, side === "YES" ? 1 : 2, { value: wei })).wait();
}

export const quickReport = (celsius: string) => `Test report. HKO headquarters temperature: ${celsius} C.`;

export async function fundProposer(): Promise<void> {
  const { bond } = await chain(PROPOSER);
  await (await bond.getFunction("mint")(await account(PROPOSER), 1_000_000_000n)).wait();
}

export async function installWallet(page: Page, accountIndex: number, chainId = "0x7a69"): Promise<void> {
  const accounts = (await provider.send("eth_accounts", [])) as string[];
  await page.addInitScript(
    ({ accounts, index, chainId, rpc }) => {
      const KEY = "__e2eWallet";
      const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { index: number; chainId: string; connected: boolean } | null;
      const state = saved ?? { index, chainId, connected: false };
      const flags = { rejectNext: false };
      const listeners: Record<string, Array<(value: unknown) => void>> = {};
      const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
      const emit = (event: string, value: unknown) => (listeners[event] ?? []).forEach((fn) => fn(value));
      const current = () => accounts[state.index]!;
      const rejected = () => Object.assign(new Error("User rejected the request."), { code: 4001 });
      async function forward(method: string, params: unknown) {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e9), method, params: params ?? [] }),
        });
        const json = (await res.json()) as { result?: unknown; error?: { message: string; code: number; data?: unknown } };
        if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code, data: json.error.data });
        return json.result;
      }
      (window as unknown as { ethereum: unknown }).ethereum = {
        isE2EWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_requestAccounts") {
            if (flags.rejectNext) {
              flags.rejectNext = false;
              throw rejected();
            }
            state.connected = true;
            save();
            return [current()];
          }
          if (method === "eth_accounts") return state.connected ? [current()] : [];
          if (method === "eth_chainId") return state.chainId;
          if (method === "wallet_switchEthereumChain") {
            state.chainId = (params![0] as { chainId: string }).chainId;
            save();
            emit("chainChanged", state.chainId);
            return null;
          }
          if (method === "eth_sendTransaction") {
            if (flags.rejectNext) {
              flags.rejectNext = false;
              throw rejected();
            }
            return forward(method, [{ ...(params![0] as object), from: current() }]);
          }
          return forward(method, params);
        },
        on(event: string, fn: (value: unknown) => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: (value: unknown) => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      };
      (window as unknown as { __wallet: unknown }).__wallet = {
        setAccount(i: number) {
          state.index = i;
          save();
          emit("accountsChanged", [current()]);
        },
        setChain(id: string) {
          state.chainId = id;
          save();
          emit("chainChanged", id);
        },
        rejectNext() {
          flags.rejectNext = true;
        },
      };
    },
    { accounts, index: accountIndex, chainId, rpc: RPC },
  );
}

export async function connect(page: Page): Promise<void> {
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("wallet-account")).toBeVisible();
}

export async function expectTx(page: Page, result: "ok" | "failed"): Promise<void> {
  await expect(page.getByTestId("tx-status").first()).toHaveAttribute("data-result", result, { timeout: 30_000 });
}
