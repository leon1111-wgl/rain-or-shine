import { readFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, getAddress, keccak256, toUtf8Bytes, type InterfaceAbi } from "ethers";
import { METRIC_ARTIFACTS, readMetricManifest } from "./lib/metric-deployment.js";
import { assertUmaSepoliaReady, readUmaSepoliaConfig, readUmaSepoliaSnapshot } from "./lib/uma-sepolia.js";

const manifest = await readMetricManifest("sepolia");
const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? manifest.publicRpcUrl, undefined, { cacheTimeout: -1 });
try {
  const config = await readUmaSepoliaConfig();
  const snapshot = await readUmaSepoliaSnapshot(provider, config);
  assertUmaSepoliaReady(snapshot, config);
  const abi: Record<string, InterfaceAbi> = {};
  for (const name of ["PredictionMarket", "UmaMetricOracleAdapter"] as const) {
    const entry = manifest.contracts[name];
    const artifact = JSON.parse(await readFile(METRIC_ARTIFACTS[name], "utf8")) as { abi: InterfaceAbi };
    if (keccak256(toUtf8Bytes(JSON.stringify(artifact.abi))) !== entry.abiKeccak256) throw new Error(name + " ABI differs from the deployed manifest");
    abi[name] = artifact.abi;
    const [code, receipt] = await Promise.all([
      provider.getCode(entry.address, snapshot.blockNumber), provider.getTransactionReceipt(entry.transactionHash),
    ]);
    if (code === "0x" || keccak256(code) !== entry.runtimeCodeKeccak256
      || !receipt || receipt.status !== 1 || receipt.blockNumber !== entry.blockNumber
      || !receipt.contractAddress || getAddress(receipt.contractAddress) !== getAddress(entry.address)
      || getAddress(receipt.from) !== getAddress(manifest.admin)) throw new Error(name + " code or deployment receipt mismatch");
  }
  const market = new Contract(manifest.contracts.PredictionMarket.address, abi.PredictionMarket!, provider);
  const adapter = new Contract(manifest.contracts.UmaMetricOracleAdapter.address, abi.UmaMetricOracleAdapter!, provider);
  const at = { blockTag: snapshot.blockNumber };
  const [admin, boundAdapter, boundMarket, oracle, currency, policy, identifier, bond, binding] = await Promise.all([
    market.getFunction("metricAdmin")(at), market.getFunction("oracleAdapter")(at),
    adapter.getFunction("market")(at), adapter.getFunction("oov3")(at), adapter.getFunction("bondCurrency")(at),
    adapter.getFunction("policyBond")(at), adapter.getFunction("identifier")(at), adapter.getFunction("bondAmount")(at),
    provider.getTransactionReceipt(manifest.bindingTransactionHash),
  ]);
  const manifestPolicy = BigInt(manifest.oracle.policyBond);
  if (getAddress(String(admin)) !== getAddress(manifest.admin)
    || getAddress(String(boundAdapter)) !== getAddress(manifest.contracts.UmaMetricOracleAdapter.address)
    || getAddress(String(boundMarket)) !== getAddress(manifest.contracts.PredictionMarket.address)
    || getAddress(String(oracle)) !== snapshot.oracle || getAddress(String(currency)) !== snapshot.currency
    || getAddress(manifest.oracle.optimisticOracleV3) !== snapshot.oracle
    || getAddress(manifest.oracle.bondCurrency) !== snapshot.currency
    || policy !== manifestPolicy || identifier !== snapshot.identifier || identifier !== manifest.oracle.identifier
    || bond !== (snapshot.minimumBond > manifestPolicy ? snapshot.minimumBond : manifestPolicy)
    || snapshot.oracleCodeHash !== manifest.oracle.runtimeCodeKeccak256
    || snapshot.currencyCodeHash !== manifest.oracle.bondRuntimeCodeKeccak256
    || snapshot.symbol !== manifest.oracle.bondSymbol || snapshot.decimals !== manifest.oracle.bondDecimals
    || !binding || binding.status !== 1 || !binding.to
    || getAddress(binding.to) !== getAddress(manifest.contracts.PredictionMarket.address)) {
    throw new Error("Numeric market/adapter/UMA binding or manifest does not match chain state");
  }
  console.log(JSON.stringify({
    verified: true, environment: "SEPOLIA_UMA", chainId: snapshot.chainId, blockNumber: snapshot.blockNumber,
    market: manifest.contracts.PredictionMarket.address, adapter: manifest.contracts.UmaMetricOracleAdapter.address,
    minimumBond: snapshot.minimumBond.toString(), bondAmount: String(bond), dvmSupport: false,
    scope: "Read-only code, receipts, bindings and current UMA parameter checks; no assertion or DVM result is implied.",
  }, null, 2));
} finally {
  provider.destroy();
}
