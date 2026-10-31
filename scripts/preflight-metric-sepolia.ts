import { mkdir, writeFile } from "node:fs/promises";
import { Contract, JsonRpcProvider, decodeBytes32String, getAddress } from "ethers";
import {
  ERC20_READ_ABI, SEPOLIA_DEPLOY_GAS_LIMITS, SEPOLIA_PUBLIC_RPC,
  assertUmaSepoliaReady, bondPolicy, deploymentBudget, jsonWithBigInts,
  readUmaSepoliaConfig, readUmaSepoliaSnapshot,
} from "./lib/uma-sepolia.js";

const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL ?? SEPOLIA_PUBLIC_RPC, undefined, { cacheTimeout: -1 });
const report: Record<string, unknown> = {
  kind: "NUMERIC_SEPOLIA_PREFLIGHT", environment: "SEPOLIA_UMA", ranAt: new Date().toISOString(),
  rpc: process.env.SEPOLIA_RPC_URL ? "SEPOLIA_RPC_URL (not recorded)" : SEPOLIA_PUBLIC_RPC,
  broadcasts: 0, dvmSupport: false,
  note: "Read-only. Sepolia assertions use real OOv3; disputed bonds can remain locked without a DVM answer. ASSERT_TRUTH is checked live for this testnet, not recommended as a new mainnet integration identifier.",
};
try {
  const config = await readUmaSepoliaConfig();
  const snapshot = await readUmaSepoliaSnapshot(provider, config);
  report.snapshot = snapshot;
  assertUmaSepoliaReady(snapshot, config);
  report.identifier = decodeBytes32String(snapshot.identifier);
  report.identifierCache = snapshot.identifierCached ? "already populated" : "OOv3 will populate from the live whitelist during assertTruth";
  const policy = bondPolicy(snapshot);
  report.bond = policy;
  report.deployGasCaps = SEPOLIA_DEPLOY_GAS_LIMITS;
  const account = process.env.SEPOLIA_CHECK_ADDRESS?.trim();
  if (account) {
    const address = getAddress(account);
    const token = new Contract(snapshot.currency, ERC20_READ_ABI, provider);
    const [balance, tokenBalance, fees, latestNonce, pendingNonce] = await Promise.all([
      provider.getBalance(address), token.getFunction("balanceOf")(address) as Promise<bigint>,
      provider.getFeeData(), provider.getTransactionCount(address, "latest"), provider.getTransactionCount(address, "pending"),
    ]);
    report.account = { address, ethBalance: balance, tokenBalance, latestNonce, pendingNonce };
    if (latestNonce !== pendingNonce) throw new Error("Deployer has pending transactions; wait before preparing deployment nonces");
    report.deploymentBudget = deploymentBudget(fees, balance);
    report.proposalFunding = tokenBalance >= policy.bondAmount ? "can fund one proposal bond" : "needs test tokens before proposing (deployment itself does not spend tokens)";
    report.status = "PASS";
  } else {
    report.status = "ORACLE_PASS_ACCOUNT_NOT_CHECKED";
    report.accountCheck = "Set public SEPOLIA_CHECK_ADDRESS to check ETH, test-token balance, pending nonce and the conservative deployment budget. No private key is needed.";
  }
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  provider.destroy();
  await mkdir("evidence/preflight", { recursive: true });
  const file = `evidence/preflight/numeric-sepolia-${String(report.ranAt).replaceAll(":", "-")}.json`;
  await writeFile(file, jsonWithBigInts(report));
  console.log(jsonWithBigInts(report));
  console.log("Saved " + file);
}
