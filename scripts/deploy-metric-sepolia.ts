import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { getAddress, getCreateAddress, keccak256, toUtf8Bytes, type TransactionRequest, type TransactionReceipt } from "ethers";
import hre from "hardhat";
import { metricManifestFile, type MetricContractDeployment, type MetricDeploymentManifest } from "./lib/metric-deployment.js";
import {
  SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOY_GAS_LIMITS, SEPOLIA_PUBLIC_RPC,
  assertUmaSepoliaReady, bondPolicy, deploymentBudget, jsonWithBigInts,
  readUmaSepoliaConfig, readUmaSepoliaSnapshot,
} from "./lib/uma-sepolia.js";

// Broadcasting needs this variable. Preflight needs no key and no confirmation.
if (process.env.DEPLOY_CONFIRM !== "sepolia") throw new Error("Broadcast disabled. Review npm run preflight:metric:sepolia, then explicitly set DEPLOY_CONFIRM=sepolia.");
const expectedAdminInput = process.env.SEPOLIA_CHECK_ADDRESS?.trim();
if (!expectedAdminInput) throw new Error("Set SEPOLIA_CHECK_ADDRESS to the public administrator address checked by preflight before deploying");
const expectedAdmin = getAddress(expectedAdminInput);
const manifestFile = metricManifestFile("sepolia");
if (existsSync(manifestFile)) throw new Error(`${manifestFile} already exists; review/archive the existing deployment before deploying again`);
const connection = await hre.network.create();
let journalFile = "";
let broadcastAttempted = false;
const journal: Record<string, unknown> = {
  kind: "NUMERIC_SEPOLIA_DEPLOYMENT_JOURNAL", startedAt: new Date().toISOString(),
  status: "PREFLIGHT", expectedAdmin, transactions: [],
};
const transactions: Array<{ name: string; hash: string; nonce: number; status?: number; blockNumber?: number; gasUsed?: bigint }> = [];
const persist = async () => { if (journalFile) await writeFile(journalFile, jsonWithBigInts({ ...journal, transactions })); };
try {
  if (connection.networkName !== "sepolia" || connection.networkConfig.type !== "http") throw new Error("Use hardhat run --network sepolia");
  const { ethers } = connection;
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== BigInt(SEPOLIA_CHAIN_ID)) throw new Error("Refusing any network other than Sepolia 11155111");
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("Configure SEPOLIA_DEPLOYER_KEY for the Sepolia deployer");
  const adminAddress = getAddress(await admin.getAddress());
  assert.equal(adminAddress, expectedAdmin,
    `Signing account ${adminAddress} does not match SEPOLIA_CHECK_ADDRESS ${expectedAdmin}; no deployment transaction was sent`);
  const config = await readUmaSepoliaConfig();
  const snapshot = await readUmaSepoliaSnapshot(provider, config);
  assertUmaSepoliaReady(snapshot, config);
  const policy = bondPolicy(snapshot);
  const [latestNonce, pendingNonce, balance, fees, marketFactory, adapterFactory] = await Promise.all([
    provider.getTransactionCount(adminAddress, "latest"), provider.getTransactionCount(adminAddress, "pending"),
    provider.getBalance(adminAddress), provider.getFeeData(),
    ethers.getContractFactory("PredictionMarket", admin), ethers.getContractFactory("UmaMetricOracleAdapter", admin),
  ]);
  if (latestNonce !== pendingNonce) throw new Error("Deployer has pending transactions; wait before deploying");
  const budget = deploymentBudget(fees, balance);
  const mainAddress = getCreateAddress({ from: adminAddress, nonce: latestNonce });
  const adapterAddress = getCreateAddress({ from: adminAddress, nonce: latestNonce + 1 });
  const publicRpcUrl = process.env.SEPOLIA_PUBLIC_RPC_URL ?? SEPOLIA_PUBLIC_RPC;
  const publicUrl = new URL(publicRpcUrl);
  if (!/^https?:$/.test(publicUrl.protocol) || publicUrl.username || publicUrl.password) throw new Error("SEPOLIA_PUBLIC_RPC_URL must be a public HTTP(S) endpoint without credentials");

  // Encode both constructors before the first paid transaction. Adapter gas estimation needs the main contract.
  // The total cap covers all three limits.
  const mainRequest = await marketFactory.getDeployTransaction(adminAddress);
  const adapterRequest = await adapterFactory.getDeployTransaction(snapshot.oracle, mainAddress, snapshot.currency, policy.policyBond);
  for (const request of [mainRequest, adapterRequest]) {
    if (typeof request.data !== "string" || request.data.length <= 2 || (request.data.length - 2) / 2 > 49152) {
      throw new Error("Invalid or oversized deployment initcode; compile the production profile");
    }
  }
  for (const name of ["PredictionMarket", "UmaMetricOracleAdapter"] as const) {
    const artifact = await hre.artifacts.readArtifact(name);
    if ((artifact.deployedBytecode.length - 2) / 2 > 24576) throw new Error(`${name} exceeds deployable runtime size; do not use coverage artifacts`);
  }
  if (await provider.getCode(mainAddress) !== "0x" || await provider.getCode(adapterAddress) !== "0x") throw new Error("Predicted deployment address already has code");
  const mainEstimate = await admin.estimateGas(mainRequest);
  await mkdir("evidence/deploy", { recursive: true });
  journalFile = `evidence/deploy/numeric-sepolia-${String(journal.startedAt).replaceAll(":", "-")}.json`;
  Object.assign(journal, {
    status: "PREPARED", admin: adminAddress, snapshot, policy, budget,
    gasLimits: SEPOLIA_DEPLOY_GAS_LIMITS, mainEstimate,
    planned: { mainAddress, adapterAddress, firstNonce: latestNonce },
    note: "Three separate transactions. A later failure can leave a partial deployment; inspect this journal before retrying. No token minting, approvals or UMA parameter changes are performed.",
  });
  await persist();
  if (mainEstimate > SEPOLIA_DEPLOY_GAS_LIMITS.PredictionMarket) {
    throw new Error(`PredictionMarket estimate ${mainEstimate} exceeds its gas cap ${SEPOLIA_DEPLOY_GAS_LIMITS.PredictionMarket}; see ${journalFile}`);
  }
  console.log(jsonWithBigInts({ journal: journalFile, admin: adminAddress, mainAddress, adapterAddress, policy, budget }));

  const send = async (name: string, request: TransactionRequest, gasLimit: bigint): Promise<TransactionReceipt> => {
    const fresh = await readUmaSepoliaSnapshot(provider, config);
    assertUmaSepoliaReady(fresh, config);
    bondPolicy(fresh);
    const nonce = latestNonce + transactions.length;
    if (await provider.getTransactionCount(adminAddress, "pending") !== nonce) throw new Error("Deployer nonce changed; stop and inspect the deployment journal");
    const estimate = await admin.estimateGas({ ...request, nonce });
    if (estimate > gasLimit) throw new Error(`${name} estimate ${estimate} exceeds its gas cap ${gasLimit}`);
    journal.status = "SUBMITTING";
    journal.currentAttempt = { name, nonce, gasLimit, estimate };
    await persist();
    // An RPC may accept a transaction and then time out. The hash is then missing.
    // A timeout does not prove that nothing was sent.
    broadcastAttempted = true;
    const tx = await admin.sendTransaction({
      ...request, nonce, gasLimit,
      maxFeePerGas: budget.maxFeePerGas, maxPriorityFeePerGas: budget.maxPriorityFeePerGas,
    });
    const entry = { name, hash: tx.hash, nonce } as (typeof transactions)[number];
    transactions.push(entry);
    journal.status = "BROADCAST";
    await persist();
    console.log(name + " broadcast: " + tx.hash);
    const receipt = await tx.wait(1, 180_000);
    if (!receipt || receipt.status !== 1) throw new Error(`${name} was not successfully confirmed; inspect ${tx.hash}`);
    Object.assign(entry, { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed });
    await persist();
    return receipt;
  };
  const mainReceipt = await send("PredictionMarket", mainRequest, SEPOLIA_DEPLOY_GAS_LIMITS.PredictionMarket);
  assert.equal(getAddress(mainReceipt.contractAddress!), mainAddress);
  const adapterReceipt = await send("UmaMetricOracleAdapter", adapterRequest, SEPOLIA_DEPLOY_GAS_LIMITS.UmaMetricOracleAdapter);
  assert.equal(getAddress(adapterReceipt.contractAddress!), adapterAddress);
  const market = await ethers.getContractAt("PredictionMarket", mainAddress, admin);
  const adapter = await ethers.getContractAt("UmaMetricOracleAdapter", adapterAddress, admin);
  const binding = await send("binding", {
    to: mainAddress, data: market.interface.encodeFunctionData("setOracleAdapter", [adapterAddress]),
  }, SEPOLIA_DEPLOY_GAS_LIMITS.binding);

  // A load-balanced RPC may answer "latest" from a node without the binding.
  // Wait for the head. Then read at the binding block.
  for (let tries = 0; await provider.getBlockNumber() < binding.blockNumber; tries++) {
    if (tries >= 30) throw new Error("RPC head did not reach the binding block; see " + journalFile);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const at = { blockTag: binding.blockNumber };
  assert.equal(getAddress(await market.metricAdmin(at)), adminAddress);
  assert.equal(getAddress(await market.oracleAdapter(at)), adapterAddress);
  assert.equal(getAddress(await adapter.market(at)), mainAddress);
  assert.equal(getAddress(await adapter.oov3(at)), snapshot.oracle);
  assert.equal(getAddress(await adapter.bondCurrency(at)), snapshot.currency);
  assert.equal(await adapter.policyBond(at), policy.policyBond);
  assert.equal(await adapter.identifier(at), snapshot.identifier);
  const finalSnapshot = await readUmaSepoliaSnapshot(provider, config);
  assertUmaSepoliaReady(finalSnapshot, config);
  const describe = async (name: "PredictionMarket" | "UmaMetricOracleAdapter", address: string, receipt: TransactionReceipt, args: (string | number)[]): Promise<MetricContractDeployment> => {
    const code = await provider.getCode(address, binding.blockNumber);
    assert.notEqual(code, "0x");
    const artifact = await hre.artifacts.readArtifact(name);
    return {
      address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, constructorArguments: args,
      abiKeccak256: keccak256(toUtf8Bytes(JSON.stringify(artifact.abi))), runtimeCodeKeccak256: keccak256(code),
    };
  };
  const manifest: MetricDeploymentManifest = {
    schemaVersion: 1, product: "rainpool-metric-v1", environment: "SEPOLIA_UMA", network: "sepolia",
    chainId: SEPOLIA_CHAIN_ID, publicRpcUrl, deployedAt: new Date().toISOString(), admin: adminAddress,
    bindingTransactionHash: binding.hash,
    contracts: {
      PredictionMarket: await describe("PredictionMarket", mainAddress, mainReceipt, [adminAddress]),
      UmaMetricOracleAdapter: await describe("UmaMetricOracleAdapter", adapterAddress, adapterReceipt, [
        snapshot.oracle, mainAddress, snapshot.currency, policy.policyBond.toString(),
      ]),
    },
    oracle: {
      optimisticOracleV3: snapshot.oracle, bondCurrency: snapshot.currency, bondSymbol: snapshot.symbol,
      bondDecimals: snapshot.decimals, policyBond: policy.policyBond.toString(),
      minimumBond: finalSnapshot.minimumBond.toString(), identifier: snapshot.identifier,
      runtimeCodeKeccak256: snapshot.oracleCodeHash, bondRuntimeCodeKeccak256: snapshot.currencyCodeHash,
      dvmSupport: false,
      note: "SEPOLIA_UMA: real canonical OOv3. Undisputed assertions may settle; Sepolia does not provide DVM vote resolution. Disputed bonds may remain locked. ASSERT_TRUTH is verified for this testnet deployment only.",
    },
  };
  await mkdir("deployments", { recursive: true });
  await writeFile(manifestFile, jsonWithBigInts(manifest), { flag: "wx" });
  journal.status = "COMPLETE";
  journal.manifest = manifestFile;
  await persist();
  console.log("Verified and wrote " + manifestFile);
} catch (error) {
  journal.status = broadcastAttempted ? "INCOMPLETE_CHECK_JOURNAL" : "FAILED_BEFORE_BROADCAST";
  journal.error = error instanceof Error ? error.message : String(error);
  await persist();
  throw error;
} finally {
  await connection.close();
}
