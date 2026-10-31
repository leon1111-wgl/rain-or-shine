import {
  Contract, Interface, JsonRpcProvider, ZeroAddress, ZeroHash,
  decodeBytes32String, encodeBytes32String, getAddress, isError, keccak256, toUtf8Bytes, toUtf8String,
  type ContractRunner, type InterfaceAbi, type Provider,
} from "ethers";
import generatedAbi from "../generated/metric-abi.json";
import generatedDeployments from "../generated/metric-deployments.json";
import { PacedReadProvider, SEPOLIA_FALLBACK_RPC } from "./rpc-reader";
import {
  assertNumericMarketRulesMatchChain, type NumericRulesChainExpectation,
} from "@shared/metric/numeric-rules";
import {
  deployedContractNames, validateMetricManifest, type MetricDeploymentManifest,
} from "@shared/metric/deployment";
import type {
  PredictionMarket, UmaMetricOracleAdapter, TestBondToken, MockOptimisticOracleV3, IOptimisticOracleV3,
} from "../../../types/ethers-contracts/index.js";

const CONTRACT_NAMES = ["PredictionMarket", "UmaMetricOracleAdapter", "TestBondToken", "MockOptimisticOracleV3"] as const;
type ContractName = typeof CONTRACT_NAMES[number] | "IOptimisticOracleV3";
const ABI = generatedAbi as unknown as Record<ContractName, InterfaceAbi>;
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
type BondToken = Pick<TestBondToken, "balanceOf" | "allowance" | "approve" | "decimals" | "symbol">;
export const MAX_DASHBOARD_MARKETS = 200;
export const MAX_DASHBOARD_METRICS = 200;

export type MetricDeployment = MetricDeploymentManifest;

export interface MetricView {
  id: number;
  code: string;
  unit: string;
  minValue: number;
  maxValue: number;
  valueStep: number;
  allowsTrace: boolean;
  rulesHash: string;
}

export interface MarketView {
  id: number;
  config: Awaited<ReturnType<PredictionMarket["getMarketConfig"]>>;
  state: Awaited<ReturnType<PredictionMarket["getMarketState"]>>;
  metric: MetricView;
  rulesDocument: string;
  rulesHash: string;
  title: string;
  position: Awaited<ReturnType<PredictionMarket["getPosition"]>>;
  claimable: bigint;
  assertion: Awaited<ReturnType<PredictionMarket["getAssertion"]>>;
  oracleAssertion?: Awaited<ReturnType<IOptimisticOracleV3["getAssertion"]>>;
  effectiveTerminal: bigint;
  effectiveRefundReason: bigint;
  mockResolutionReady: boolean;
  mockResolution?: boolean;
  settlementReady?: boolean;
  settlementUnavailable?: string;
}

export interface Dashboard {
  now: number;
  blockNumber: number;
  metrics: MetricView[];
  markets: MarketView[];
  bondBalance: bigint;
  bondAmount: bigint;
}

const sameAddress = (a: string, b: string) => getAddress(a) === getAddress(b);

/** Reject legacy ABI exports even when their old manifests agree. */
export function assertNumericMarketAbi(abi: InterfaceAbi): void {
  const message = "The exported market interface is outdated. Deploy and export the numeric contracts for this network (local: npm run deploy:metric:local; Sepolia: npm run deploy:metric:sepolia).";
  try {
    const iface = new Interface(abi);
    const create = iface.getFunction("createMarket");
    const read = iface.getFunction("getMarketConfig");
    const expected = [
      ["proposer", "address"], ["sourceId", "bytes32"], ["subjectId", "bytes32"],
      ["condition", "tuple"], ["times", "tuple"],
    ];
    for (const tuple of [create?.inputs[0], read?.outputs[0]]) {
      if (!tuple?.components || tuple.components.length !== expected.length
        || tuple.components.some((field, i) => field.name !== expected[i]?.[0] || field.baseType !== expected[i]?.[1])) {
        throw new Error(message);
      }
    }
  } catch { throw new Error(message); }
}

export function selectMetricDeployment(
  source: { deployments: Record<string, unknown> } = generatedDeployments,
  requested: string | undefined = import.meta.env.VITE_TARGET_CHAIN_ID as string | undefined,
): MetricDeployment {
  assertNumericMarketAbi(ABI.PredictionMarket);
  const target = requested ?? "31337";
  if (target !== "31337" && target !== "11155111") throw new Error("Only local chain 31337 and Sepolia 11155111 are supported.");
  const selected = source.deployments[target];
  if (!selected) {
    throw new Error(target === "11155111"
      ? "Sepolia deployment is missing. Deploy and export the numeric Sepolia contracts before starting this app."
      : "Local deployment is missing. Run npm run deploy:metric:local first.");
  }
  const dep = validateMetricManifest(selected);
  if (String(dep.chainId) !== target) throw new Error("The selected network does not match the deployment chain ID.");
  for (const name of deployedContractNames(dep)) {
    const entry = dep.contracts[name]!;
    if (keccak256(toUtf8Bytes(JSON.stringify(ABI[name]))) !== entry.abiKeccak256) {
      throw new Error(`${name} ABI does not match the deployment. Check the contract version and export the correct ABI.`);
    }
  }
  return dep;
}

export function createReader(dep: MetricDeployment): JsonRpcProvider {
  // Never pin the network without checking it: a local RPC can be restarted or switched.
  if (dep.environment === "SEPOLIA_UMA") return new PacedReadProvider(dep.publicRpcUrl, 1000, SEPOLIA_FALLBACK_RPC);
  return new JsonRpcProvider(dep.publicRpcUrl, undefined, { batchMaxCount: 20, cacheTimeout: -1 });
}

export const marketOf = (dep: MetricDeployment, runner: ContractRunner) =>
  new Contract(dep.contracts.PredictionMarket.address, ABI.PredictionMarket, runner) as unknown as PredictionMarket;
export const adapterOf = (dep: MetricDeployment, runner: ContractRunner) =>
  new Contract(dep.contracts.UmaMetricOracleAdapter.address, ABI.UmaMetricOracleAdapter, runner) as unknown as UmaMetricOracleAdapter;
export const tokenOf = (dep: MetricDeployment, runner: ContractRunner) =>
  new Contract(dep.oracle.bondCurrency, TOKEN_ABI, runner) as unknown as BondToken;
export const oracleOf = (dep: MetricDeployment, runner: ContractRunner) =>
  new Contract(dep.oracle.optimisticOracleV3, ABI.IOptimisticOracleV3, runner) as unknown as IOptimisticOracleV3;

export function mockOracleOf(dep: MetricDeployment, runner: ContractRunner): MockOptimisticOracleV3 {
  if (dep.environment !== "LOCAL_MOCK" || dep.chainId !== 31337 || !dep.contracts.MockOptimisticOracleV3) {
    throw new Error("Mock oracle operations are available on the local chain only");
  }
  return new Contract(dep.contracts.MockOptimisticOracleV3.address, ABI.MockOptimisticOracleV3, runner) as unknown as MockOptimisticOracleV3;
}

export function localTokenOf(dep: MetricDeployment, runner: ContractRunner): TestBondToken {
  if (dep.environment !== "LOCAL_MOCK" || dep.chainId !== 31337 || !dep.contracts.TestBondToken) {
    throw new Error("Test token minting is available on the local chain only");
  }
  return new Contract(dep.contracts.TestBondToken.address, ABI.TestBondToken, runner) as unknown as TestBondToken;
}

/** Bind displayed rules to independently read chain state. */
export function numericContextForMarket(market: MarketView): NumericRulesChainExpectation {
  return {
    config: market.config,
    metricId: market.metric.id,
    metric: {
      code: encodeBytes32String(market.metric.code),
      unit: encodeBytes32String(market.metric.unit),
      minValue: market.metric.minValue,
      maxValue: market.metric.maxValue,
      valueStep: market.metric.valueStep,
      allowsTrace: market.metric.allowsTrace,
      rulesHash: market.metric.rulesHash,
    },
    marketRulesHash: market.rulesHash,
  };
}

/** Read submission context at one block and reject a changed block. */
export async function readNumericContext(dep: MetricDeployment, reader: Provider, marketId: number) {
  if (!Number.isSafeInteger(marketId) || marketId <= 0) throw new Error("Invalid market ID");
  const [network, block] = await Promise.all([reader.getNetwork(), reader.getBlock("latest")]);
  if (network.chainId !== BigInt(dep.chainId)) throw new Error("The RPC network changed while reading the market");
  if (!block?.hash) throw new Error("Unable to read the latest block");
  const at = { blockTag: block.number };
  const market = marketOf(dep, reader);
  const config = await market.getMarketConfig(marketId, at);
  const metricId = config.condition.metricId;
  const [metric, marketRulesHash] = await Promise.all([
    market.getMetric(metricId, at), market.marketRulesHash(marketId, at),
  ]);
  const unchanged = await reader.getBlock(block.number);
  if (unchanged?.hash !== block.hash) throw new Error("The chain reorganized or restarted during the read. Import the result again");
  const expected: NumericRulesChainExpectation = { config, metricId, metric, marketRulesHash };
  return { expected, chainTimestamp: block.timestamp };
}

export function marketSourceLabel(market: MarketView): string {
  try {
    const rules = assertNumericMarketRulesMatchChain(market.rulesDocument, numericContextForMarket(market));
    return rules.synthetic ? "Synthetic demo" : rules.config.sourceId === "HKO_DAILY_EXTRACT" ? "Hong Kong Observatory" : "Live data";
  } catch { return "Unrecognized rules"; }
}

/** Call at startup and immediately before writes. A successful old check is not permanent. */
export async function verifyMetricDeployment(dep: MetricDeployment, reader: Provider): Promise<void> {
  assertNumericMarketAbi(ABI.PredictionMarket);
  validateMetricManifest(dep);
  const network = await reader.getNetwork();
  if (network.chainId !== BigInt(dep.chainId)) throw new Error(`RPC network mismatch: expected ${dep.chainId}, received ${network.chainId}.`);
  const block = await reader.getBlock("latest");
  if (!block) throw new Error("Unable to read the latest block.");
  const at = { blockTag: block.number };
  await Promise.all(deployedContractNames(dep).map(async (name) => {
    const entry = dep.contracts[name]!;
    const [code, receipt] = await Promise.all([
      reader.getCode(entry.address, block.number),
      reader.getTransactionReceipt(entry.transactionHash),
    ]);
    if (!receipt) {
      throw new Error(`${name} deployment receipt is unavailable from this RPC. Use a ${dep.network} RPC with historical transaction receipts in the app and wallet, then retry. No redeployment is required solely for an unavailable receipt.`);
    }
    if (code === "0x" || keccak256(code) !== entry.runtimeCodeKeccak256 ||
        receipt.status !== 1 || receipt.blockNumber !== entry.blockNumber ||
        !receipt.contractAddress || !sameAddress(receipt.contractAddress, entry.address)) {
      throw new Error(`${name} does not match the deployment. Check the network, addresses and exported configuration.`);
    }
  }));
  const market = marketOf(dep, reader), adapter = adapterOf(dep, reader);
  const token = tokenOf(dep, reader), oracle = oracleOf(dep, reader);
  const [boundAdapter, boundMarket, admin, oo, currency, policy, identifier, decimals, symbol, oracleIdentifier, binding] = await Promise.all([
    market.oracleAdapter(at), adapter.market(at), market.metricAdmin(at), adapter.oov3(at),
    adapter.bondCurrency(at), adapter.policyBond(at), adapter.identifier(at), token.decimals(at),
    token.symbol(at), oracle.defaultIdentifier(at),
    reader.getTransactionReceipt(dep.bindingTransactionHash),
  ]);
  if (!binding) {
    throw new Error(`The adapter binding receipt is unavailable from this RPC. Use a ${dep.network} RPC with historical transaction receipts in the app and wallet, then retry. No redeployment is required solely for an unavailable receipt.`);
  }
  if (!sameAddress(boundAdapter, dep.contracts.UmaMetricOracleAdapter.address) ||
      !sameAddress(boundMarket, dep.contracts.PredictionMarket.address) ||
      !sameAddress(admin, dep.admin) ||
      !sameAddress(oo, dep.oracle.optimisticOracleV3) || !sameAddress(currency, dep.oracle.bondCurrency) ||
      policy !== BigInt(dep.oracle.policyBond) || identifier !== dep.oracle.identifier || identifier !== oracleIdentifier ||
      decimals !== BigInt(dep.oracle.bondDecimals) || symbol !== dep.oracle.bondSymbol ||
      binding.status !== 1 || !binding.to || !sameAddress(binding.to, dep.contracts.PredictionMarket.address)) {
    throw new Error("Market, adapter, oracle or bond token bindings do not match the deployment.");
  }
  if (dep.environment === "LOCAL_MOCK") {
    const mock = mockOracleOf(dep, reader);
    if (!sameAddress(await mock.admin(at), dep.admin)) throw new Error("The local mock administrator does not match.");
  } else {
    // External UMA/token contracts are not deployments made by this project.
    const [oracleCode, bondCode] = await Promise.all([
      reader.getCode(dep.oracle.optimisticOracleV3, block.number),
      reader.getCode(dep.oracle.bondCurrency, block.number),
    ]);
    if (oracleCode === "0x" || keccak256(oracleCode) !== dep.oracle.runtimeCodeKeccak256 ||
        bondCode === "0x" || keccak256(bondCode) !== dep.oracle.bondRuntimeCodeKeccak256) {
      throw new Error("The Sepolia oracle or bond token code does not match the verified deployment.");
    }
  }
}

/** Dynamic admission policy applies to new oracle submissions, never market claims/refunds. */
export async function assertOracleSubmissionSupported(dep: MetricDeployment, runner: ContractRunner): Promise<void> {
  const at = { blockTag: "latest" };
  if (dep.environment === "LOCAL_MOCK") {
    if (!await mockOracleOf(dep, runner).isWhitelisted(dep.oracle.bondCurrency, at)) {
      throw new Error("This bond token is not supported by the local mock. New assertions and disputes are unavailable.");
    }
    return;
  }
  const finderAddress = await new Contract(dep.oracle.optimisticOracleV3, ["function finder() view returns (address)"], runner).getFunction("finder")(at) as string;
  const finder = new Contract(finderAddress, ["function getImplementationAddress(bytes32) view returns (address)"], runner);
  const [collateralAddress, identifierAddress] = await Promise.all([
    finder.getFunction("getImplementationAddress")(encodeBytes32String("CollateralWhitelist"), at) as Promise<string>,
    finder.getFunction("getImplementationAddress")(encodeBytes32String("IdentifierWhitelist"), at) as Promise<string>,
  ]);
  const collateral = new Contract(collateralAddress, ["function isOnWhitelist(address) view returns (bool)"], runner);
  const identifiers = new Contract(identifierAddress, ["function isIdentifierSupported(bytes32) view returns (bool)"], runner);
  const [currencySupported, identifierSupported] = await Promise.all([
    collateral.getFunction("isOnWhitelist")(dep.oracle.bondCurrency, at),
    identifiers.getFunction("isIdentifierSupported")(dep.oracle.identifier, at),
  ]);
  if (!currencySupported) throw new Error("Sepolia UMA no longer supports this bond token in CollateralWhitelist. New assertions and disputes are unavailable.");
  if (!identifierSupported) throw new Error("Sepolia UMA no longer supports this identifier in IdentifierWhitelist. New assertions and disputes are unavailable.");
}

/** Read-only settlement simulation. GetAssertionResult is not a readiness check. */
export async function readAssertionStatus(
  dep: MetricDeployment, reader: Provider, assertionId: string, block: { number: number; timestamp: number },
) {
  const oracle = oracleOf(dep, reader);
  const at = { blockTag: block.number };
  const oracleAssertion = await oracle.getAssertion(assertionId, at);
  let mockResolutionReady = false;
  let mockResolution: boolean | undefined;
  let settlementReady = false;
  let settlementUnavailable: string | undefined;
  if (dep.environment === "LOCAL_MOCK") {
    const mock = mockOracleOf(dep, reader);
    mockResolutionReady = await mock.hasSimulatedResolution(assertionId, at);
    if (mockResolutionReady) mockResolution = await mock.simulatedResolution(assertionId, at);
    settlementReady = !oracleAssertion.settled && (oracleAssertion.disputer !== ZeroAddress
      ? mockResolutionReady : BigInt(block.timestamp) >= oracleAssertion.expirationTime);
  } else if (!oracleAssertion.settled && (oracleAssertion.disputer !== ZeroAddress
      || BigInt(block.timestamp) >= oracleAssertion.expirationTime)) {
    try {
      await oracle.settleAssertion.staticCall(assertionId, at);
      settlementReady = true;
    } catch (error) {
      if (!isError(error, "CALL_EXCEPTION")) throw error;
      settlementUnavailable = "Settlement is not available yet. Check again later.";
    }
  }
  return { oracleAssertion, mockResolutionReady, mockResolution, settlementReady, settlementUnavailable };
}

function readableBytes32(value: string): string {
  try { return decodeBytes32String(value); } catch { return value; }
}

async function inBatches<T>(count: number, fn: (id: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let first = 1; first <= count; first += 10) {
    const length = Math.min(10, count - first + 1);
    results.push(...await Promise.all(Array.from({ length }, (_, index) => fn(first + index))));
  }
  return results;
}

export async function readDashboard(dep: MetricDeployment, reader: Provider, account?: string): Promise<Dashboard> {
  const block = await reader.getBlock("latest");
  if (!block) throw new Error("Unable to read the chain timestamp.");
  const at = { blockTag: block.number };
  const market = marketOf(dep, reader), adapter = adapterOf(dep, reader);
  const wallet = account ? getAddress(account) : ZeroAddress;
  const [metricCount, marketCount, bondBalance, bondAmount] = await Promise.all([
    market.metricCount(at), market.marketCount(at), tokenOf(dep, reader).balanceOf(wallet, at), adapter.bondAmount(at),
  ]);
  if (metricCount > BigInt(MAX_DASHBOARD_METRICS) || marketCount > BigInt(MAX_DASHBOARD_MARKETS)) {
    throw new Error(`This demo supports up to ${MAX_DASHBOARD_METRICS} metrics and ${MAX_DASHBOARD_MARKETS} markets. Pagination is required for larger deployments; no data has been silently omitted.`);
  }
  const metrics = await inBatches(Number(metricCount), async (id): Promise<MetricView> => {
    const definition = await market.getMetric(id, at);
    return { id, code: readableBytes32(definition.code), unit: readableBytes32(definition.unit),
      minValue: Number(definition.minValue), maxValue: Number(definition.maxValue), valueStep: Number(definition.valueStep),
      allowsTrace: definition.allowsTrace, rulesHash: definition.rulesHash };
  });
  const documents = new Map<number, { text: string; hash: string }>();
  for (let from = dep.contracts.PredictionMarket.blockNumber; from <= block.number && documents.size < Number(marketCount); from += 5000) {
    const events = await market.queryFilter(market.filters.MarketCreated(), from, Math.min(block.number, from + 4999));
    for (const event of events) {
      const id = Number(event.args.marketId);
      if (!Number.isSafeInteger(id) || id < 1 || id > Number(marketCount) || documents.has(id)) throw new Error("A MarketCreated log contains an invalid or duplicate market ID.");
      const bytes = event.args.rulesDocument;
      if (keccak256(bytes) !== event.args.rulesHash) throw new Error(`Market #${id} has an invalid rules document hash.`);
      let text: string;
      try { text = toUtf8String(bytes); } catch { throw new Error(`Market #${id} rules are not valid UTF-8 and cannot be displayed.`); }
      documents.set(id, { text, hash: event.args.rulesHash });
    }
  }
  if (documents.size !== Number(marketCount)) throw new Error("Market creation records are incomplete. Try another RPC and refresh.");
  const markets = await inBatches(Number(marketCount), async (id): Promise<MarketView> => {
    const [config, state, position, claimable, assertion, effective, rulesHash] = await Promise.all([
      market.getMarketConfig(id, at), market.getMarketState(id, at), market.getPosition(id, wallet, at),
      market.claimable(id, wallet, at), market.getAssertion(id, at), market.getEffectiveState(id, at), market.marketRulesHash(id, at),
    ]);
    const metric = metrics.find((entry) => entry.id === Number(config.condition.metricId));
    if (!metric) throw new Error(`Market #${id} references a missing metric.`);
    const document = documents.get(id);
    if (!document || document.hash !== rulesHash) throw new Error(`Market #${id} has a missing creation log or mismatched rules hash.`);
    let title = `${metric.code} · #${id}`;
    try {
      const parsed: unknown = JSON.parse(document.text);
      if (parsed && typeof parsed === "object" && "title" in parsed && typeof parsed.title === "string") title = parsed.title;
    } catch { /* Plain UTF-8 documents are valid; JSON is only a UI convention. */ }
    const hasAssertion = assertion.assertionId !== ZeroHash;
    const oracleStatus = hasAssertion ? await readAssertionStatus(dep, reader, assertion.assertionId, block)
      : { oracleAssertion: undefined, mockResolutionReady: false, mockResolution: undefined, settlementReady: false, settlementUnavailable: undefined };
    const { oracleAssertion } = oracleStatus;
    if (oracleAssertion && (!sameAddress(oracleAssertion.callbackRecipient, dep.contracts.UmaMetricOracleAdapter.address) ||
        !sameAddress(oracleAssertion.asserter, config.proposer))) throw new Error(`Market #${id} has inconsistent oracle assertion bindings.`);
    return { id, config, state, metric, rulesDocument: document.text, rulesHash, title, position, claimable,
      assertion, effectiveTerminal: effective.terminal, effectiveRefundReason: effective.reason,
      ...oracleStatus };
  });
  const unchanged = await reader.getBlock(block.number);
  if (!unchanged || unchanged.hash !== block.hash) throw new Error("The chain reorganized or restarted during the read. Refresh and try again.");
  return { now: block.timestamp, blockNumber: block.number, metrics, markets, bondBalance, bondAmount };
}


const ERROR_INTERFACES = CONTRACT_NAMES.map((name) => new Interface(ABI[name]));
const ERROR_HINTS: Record<string, string> = {
  OnlyMetricAdmin: "Only the metric administrator can perform this action", DuplicateMetricCode: "This metric code is already registered",
  InvalidMetricDefinition: "Invalid metric definition. Check the range, step and rules commitment", InvalidMarketConfig: "Invalid market configuration",
  BadRulesDocument: "Market rules must contain 1–4096 bytes", NotProposer: "Only the market's designated proposer can submit a result",
  AlreadyProposed: "Each market accepts only one assertion", ProposalWindowClosed: "The assertion submission window is closed",
  IndeterminateReading: "This reading cannot determine the outcome; the threshold may overlap the Trace range",
  InvalidReading: "The reading does not match the metric range, step or Trace rules", BadEvidence: "The evidence does not meet the numeric observation requirements",
  BettingNotOpen: "Betting has not opened", BettingClosed: "Betting has closed", SideLocked: "An account can bet on only one side of a market",
  BetTooSmall: "The minimum bet is 0.001 ETH", MarketFinal: "This market has settled or entered refunds",
  NothingToClaim: "No funds are claimable, or they have already been claimed", RefundNotAvailable: "Refunds are not available yet",
  BondAboveMax: "The bond exceeds the confirmed limit. Refresh and try again", ERC20InsufficientBalance: "Insufficient bond token balance",
  ERC20InsufficientAllowance: "Insufficient bond allowance. Approve the correct contract first",
};

export function errorMessage(error: unknown): string {
  const queue: unknown[] = [error];
  const visited = new Set<unknown>();
  let fallback: string | undefined;
  for (let i = 0; i < queue.length && i < 30; i++) {
    const entry = queue[i];
    if (!entry || visited.has(entry)) continue;
    visited.add(entry);
    if (typeof entry === "string" && /^0x[0-9a-fA-F]{8,}$/.test(entry)) {
      for (const iface of ERROR_INTERFACES) {
        try {
          const decoded = iface.parseError(entry);
          if (decoded) {
            const details = Array.from(decoded.args, (value: unknown) => String(value)).join(", ");
            return `${ERROR_HINTS[decoded.name] ?? decoded.name}${details ? ` (${details})` : ""}`;
          }
        } catch { /* Try the next contract interface. */ }
      }
    }
    if (typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      if (obj.code === 4001 || obj.code === "ACTION_REJECTED") return "Wallet signature request cancelled.";
      if (!fallback) {
        const message = obj.shortMessage ?? obj.reason ?? obj.message;
        if (typeof message === "string") {
          if (/exceeded maximum retry limit|rate limit exceeded|too many requests/i.test(message)) {
            return "The RPC is rate-limiting requests. Wait a moment, then refresh. If this continues, use another RPC in the app and wallet.";
          }
          fallback = message;
        }
      }
      for (const key of ["data", "error", "info", "cause", "originalError"]) if (obj[key] !== undefined) queue.push(obj[key]);
    }
  }
  return fallback ?? String(error);
}
