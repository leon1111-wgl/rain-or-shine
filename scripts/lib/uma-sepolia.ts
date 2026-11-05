import { readFile } from "node:fs/promises";
import {
  Contract, MaxUint256, ZeroAddress, ZeroHash, encodeBytes32String, getAddress, keccak256, parseEther, parseUnits,
  type Provider,
} from "ethers";
import { CANONICAL_SEPOLIA_OOV3, SEPOLIA_BOND_CURRENCY } from "../../src/metric/deployment.js";
export { CANONICAL_SEPOLIA_OOV3, SEPOLIA_BOND_CURRENCY } from "../../src/metric/deployment.js";

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
// Sepolia activated Glamsterdam on 2026-10-06. EIP-8037 reprices code
// deposit/state creation. Pre-upgrade 5M/4M caps cannot deploy these artifacts.
export const SEPOLIA_DEPLOY_GAS_LIMITS = Object.freeze({
  PredictionMarket: 30_000_000n, UmaMetricOracleAdapter: 25_000_000n, binding: 300_000n,
});
export const OOV3_READ_ABI = [
  "function defaultIdentifier() view returns (bytes32)",
  "function defaultCurrency() view returns (address)",
  "function finder() view returns (address)",
  "function cachedOracle() view returns (address)",
  "function burnedBondPercentage() view returns (uint256)",
  "function cachedIdentifiers(bytes32) view returns (bool)",
  "function cachedCurrencies(address) view returns (bool isWhitelisted, uint256 finalFee)",
  "function getMinimumBond(address) view returns (uint256)",
] as const;
const FINDER_ABI = ["function getImplementationAddress(bytes32) view returns (address)"];
const IDENTIFIER_ABI = ["function isIdentifierSupported(bytes32) view returns (bool)"];
const WHITELIST_ABI = ["function isOnWhitelist(address) view returns (bool)"];
const STORE_ABI = ["function computeFinalFee(address) view returns (tuple(uint256 rawValue))"];
export const ERC20_READ_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
] as const;

export interface UmaSepoliaConfig {
  chainId: 11155111;
  optimisticOracleV3: string;
  selectedBondCurrency: string;
  expected: { identifier: string; runtimeCodeKeccak256: string; bondRuntimeCodeKeccak256: string };
}
export interface UmaSepoliaSnapshot {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  oracle: string;
  oracleCodeHash: string;
  currency: string;
  currencyCodeHash: string;
  identifier: string;
  identifierSupported: boolean;
  identifierCached: boolean;
  finder: string;
  cachedOracle: string;
  finderOracle: string;
  dependencyCodePresent: boolean;
  currencySupported: boolean;
  currencyCached: boolean;
  cachedFinalFee: bigint;
  storeFinalFee: bigint;
  minimumBond: bigint;
  burnedBondPercentage: bigint;
  symbol: string;
  decimals: number;
}
const nonzeroHash = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== ZeroHash;
function fail(message: string): never { throw new Error("Sepolia preflight: " + message); }
export function validateUmaSepoliaConfig(value: unknown): UmaSepoliaConfig {
  if (typeof value !== "object" || value === null) fail("missing UMA configuration");
  const config = value as UmaSepoliaConfig;
  if (config.chainId !== SEPOLIA_CHAIN_ID
    || getAddress(config.optimisticOracleV3) !== CANONICAL_SEPOLIA_OOV3) fail("configuration is not the canonical Sepolia OOv3");
  // The adapter pins this token on Sepolia. Another currency would fail at deployment.
  if (getAddress(config.selectedBondCurrency) !== SEPOLIA_BOND_CURRENCY) fail("configuration is not the pinned Sepolia 6TEST bond currency");
  if (!config.expected || typeof config.expected.identifier !== "string" || !config.expected.identifier.trim()) fail("pin the expected identifier");
  encodeBytes32String(config.expected.identifier);
  if (!nonzeroHash(config.expected.runtimeCodeKeccak256) || !nonzeroHash(config.expected.bondRuntimeCodeKeccak256)) {
    fail("pin both OOv3 and bond-token runtime code hashes");
  }
  return config;
}
export async function readUmaSepoliaConfig(): Promise<UmaSepoliaConfig> {
  return validateUmaSepoliaConfig(JSON.parse(await readFile("config/uma-sepolia.json", "utf8")));
}
function call<T>(contract: Contract, name: string, blockTag: number, ...args: unknown[]): Promise<T> {
  return contract.getFunction(name)(...args, { blockTag }) as Promise<T>;
}

/** All mutable UMA reads are pinned to one block. This function never sends or signs a transaction. */
export async function readUmaSepoliaSnapshot(provider: Provider, config: UmaSepoliaConfig): Promise<UmaSepoliaSnapshot> {
  validateUmaSepoliaConfig(config);
  const [network, block] = await Promise.all([provider.getNetwork(), provider.getBlock("latest")]);
  if (network.chainId !== BigInt(SEPOLIA_CHAIN_ID)) fail("RPC must be Sepolia chain 11155111");
  if (!block || !block.hash) fail("latest block is unavailable");
  const at = block.number;
  const oracle = getAddress(config.optimisticOracleV3);
  const currency = getAddress(config.selectedBondCurrency);
  const [ooCode, tokenCode] = await Promise.all([provider.getCode(oracle, at), provider.getCode(currency, at)]);
  if (ooCode === "0x" || keccak256(ooCode) !== config.expected.runtimeCodeKeccak256.toLowerCase()) fail("OOv3 runtime code differs from the reviewed deployment");
  if (tokenCode === "0x" || keccak256(tokenCode) !== config.expected.bondRuntimeCodeKeccak256.toLowerCase()) fail("bond-token runtime code differs from the reviewed token");
  const oo = new Contract(oracle, OOV3_READ_ABI, provider);
  const token = new Contract(currency, ERC20_READ_ABI, provider);
  const [identifier, finder, cachedOracle, burnedBondPercentage, cache, minimumBond, symbol, decimals] = await Promise.all([
    call<string>(oo, "defaultIdentifier", at), call<string>(oo, "finder", at),
    call<string>(oo, "cachedOracle", at), call<bigint>(oo, "burnedBondPercentage", at),
    call<[boolean, bigint]>(oo, "cachedCurrencies", at, currency),
    call<bigint>(oo, "getMinimumBond", at, currency), call<string>(token, "symbol", at),
    call<bigint>(token, "decimals", at),
  ]);
  const locator = new Contract(finder, FINDER_ABI, provider);
  const [idWhitelist, collateralWhitelist, store, finderOracle] = await Promise.all(
    ["IdentifierWhitelist", "CollateralWhitelist", "Store", "Oracle"]
      .map((name) => call<string>(locator, "getImplementationAddress", at, encodeBytes32String(name))),
  );
  const [identifierSupported, identifierCached, currencySupported, finalFee, dependencyCode] = await Promise.all([
    call<boolean>(new Contract(idWhitelist!, IDENTIFIER_ABI, provider), "isIdentifierSupported", at, identifier),
    call<boolean>(oo, "cachedIdentifiers", at, identifier),
    call<boolean>(new Contract(collateralWhitelist!, WHITELIST_ABI, provider), "isOnWhitelist", at, currency),
    call<[bigint]>(new Contract(store!, STORE_ABI, provider), "computeFinalFee", at, currency),
    Promise.all([finder, idWhitelist!, collateralWhitelist!, store!, finderOracle!].map((address) => provider.getCode(address, at))),
  ]);
  const sameBlock = await provider.getBlock(at);
  if (!sameBlock || sameBlock.hash !== block.hash) fail("snapshot block was reorganized; repeat the read-only preflight");
  return {
    chainId: Number(network.chainId), blockNumber: at, blockHash: block.hash, blockTimestamp: block.timestamp,
    oracle, oracleCodeHash: keccak256(ooCode), currency, currencyCodeHash: keccak256(tokenCode),
    identifier, identifierSupported, identifierCached, finder: getAddress(finder),
    cachedOracle: getAddress(cachedOracle), finderOracle: getAddress(finderOracle!),
    dependencyCodePresent: dependencyCode.every((code) => code !== "0x"),
    currencySupported, currencyCached: cache[0], cachedFinalFee: cache[1], storeFinalFee: finalFee[0],
    minimumBond, burnedBondPercentage, symbol, decimals: Number(decimals),
  };
}

/** Refuse stale permissive caches. The current Finder whitelist must independently agree. */
export function assertUmaSepoliaReady(snapshot: UmaSepoliaSnapshot, config: UmaSepoliaConfig): void {
  validateUmaSepoliaConfig(config);
  if (snapshot.chainId !== SEPOLIA_CHAIN_ID || getAddress(snapshot.oracle) !== CANONICAL_SEPOLIA_OOV3
    || getAddress(snapshot.currency) !== getAddress(config.selectedBondCurrency)) fail("network or addresses changed");
  if (snapshot.oracleCodeHash.toLowerCase() !== config.expected.runtimeCodeKeccak256.toLowerCase()
    || snapshot.currencyCodeHash.toLowerCase() !== config.expected.bondRuntimeCodeKeccak256.toLowerCase()) fail("runtime code changed");
  if (snapshot.identifier !== encodeBytes32String(config.expected.identifier)) fail("defaultIdentifier differs from the reviewed identifier");
  if (!snapshot.identifierSupported) fail("defaultIdentifier is not currently whitelisted; do not deploy");
  // OOv3 automatically populates a false identifier cache when the live whitelist is true.
  if (!snapshot.dependencyCodePresent || snapshot.cachedOracle === ZeroAddress
    || getAddress(snapshot.cachedOracle) !== getAddress(snapshot.finderOracle)) fail("Finder dependencies or OOv3 cachedOracle are stale");
  if (!snapshot.currencySupported || !snapshot.currencyCached) fail("bond currency must be whitelisted and cached before deployment");
  if (snapshot.cachedFinalFee < 0n || snapshot.storeFinalFee < 0n || snapshot.minimumBond < 0n
    || snapshot.cachedFinalFee !== snapshot.storeFinalFee) fail("OOv3 finalFee cache differs from Store; review syncUmaParams separately");
  if (snapshot.burnedBondPercentage <= 0n || snapshot.burnedBondPercentage > 10n ** 18n) fail("invalid burned bond percentage");
  if (snapshot.minimumBond !== snapshot.storeFinalFee * 10n ** 18n / snapshot.burnedBondPercentage) fail("minimum bond is stale or inconsistent");
  if (!Number.isInteger(snapshot.decimals) || snapshot.decimals < 0 || snapshot.decimals > 36 || !snapshot.symbol.trim()) fail("unsupported bond token metadata");
}

export function bondPolicy(snapshot: UmaSepoliaSnapshot, env: NodeJS.ProcessEnv = process.env) {
  const policyBond = parseUnits(env.SEPOLIA_POLICY_BOND ?? "1", snapshot.decimals);
  const maxBond = parseUnits(env.SEPOLIA_MAX_BOND ?? "10", snapshot.decimals);
  const bondAmount = policyBond > snapshot.minimumBond ? policyBond : snapshot.minimumBond;
  if (policyBond <= 0n || policyBond > MaxUint256 || maxBond <= 0n || maxBond > MaxUint256 || bondAmount > maxBond) {
    fail("bond exceeds SEPOLIA_MAX_BOND or policy is not a positive uint256");
  }
  return { policyBond, maxBond, bondAmount };
}
export function deploymentBudget(
  fee: { maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null },
  balance: bigint,
  env: NodeJS.ProcessEnv = process.env,
) {
  const feeCap = parseUnits(env.MAX_FEE_GWEI ?? "20", "gwei");
  const costCap = parseEther(env.MAX_DEPLOY_COST_ETH ?? "0.05");
  if (fee.maxFeePerGas === null || fee.maxPriorityFeePerGas === null || fee.maxFeePerGas <= 0n
    || fee.maxPriorityFeePerGas < 0n || fee.maxPriorityFeePerGas > fee.maxFeePerGas) fail("invalid EIP-1559 fee data");
  if (feeCap <= 0n || costCap <= 0n || fee.maxFeePerGas > feeCap) fail("fee exceeds MAX_FEE_GWEI");
  const totalGasLimit = Object.values(SEPOLIA_DEPLOY_GAS_LIMITS).reduce((total, limit) => total + limit, 0n);
  const maximumCost = totalGasLimit * fee.maxFeePerGas;
  if (maximumCost > costCap) fail("conservative three-transaction cost exceeds MAX_DEPLOY_COST_ETH");
  if (balance < maximumCost) fail("deployer ETH balance cannot cover all three transaction gas caps");
  return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, totalGasLimit, maximumCost, costCap };
}
export const jsonWithBigInts = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
