import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { type BaseContract, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import hre from "hardhat";
import {
  METRIC_MANIFEST_FILE,
  type MetricContractDeployment,
  type MetricDeploymentManifest,
} from "./lib/metric-deployment.js";

const connection = await hre.network.create();
try {
  const { ethers } = connection;
  if (connection.networkName !== "localhost" || connection.networkConfig.type !== "http") {
    throw new Error("Use: hardhat run --network localhost scripts/deploy-metric-local.ts");
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 31337) throw new Error("This script only supports local chain 31337");

  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("Local node has no unlocked deployer");
  const adminAddress = await admin.getAddress();
  const bondDecimals = 6;
  const policyBond = parseUnits("10", bondDecimals);
  const minimumBond = parseUnits("1", bondDecimals);

  const bond = await ethers.deployContract("TestBondToken", ["Local metric test bond", "tBOND", bondDecimals]);
  await bond.waitForDeployment();
  const oracle = await ethers.deployContract("MockOptimisticOracleV3", [adminAddress]);
  await oracle.waitForDeployment();
  const bondAddress = await bond.getAddress();
  const oracleAddress = await oracle.getAddress();
  const whitelist = await (await oracle.setCurrency(bondAddress, true, minimumBond)).wait();
  assert.equal(whitelist?.status, 1);

  const market = await ethers.deployContract("PredictionMarket", [adminAddress]);
  await market.waitForDeployment();
  const marketAddress = await market.getAddress();
  const adapter = await ethers.deployContract("UmaMetricOracleAdapter", [
    oracleAddress, marketAddress, bondAddress, policyBond,
  ]);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();

  const binding = await (await market.setOracleAdapter(adapterAddress)).wait();
  assert.equal(binding?.status, 1);
  assert.ok(binding);

  assert.equal(await market.metricAdmin(), adminAddress);
  assert.equal(await market.oracleAdapter(), adapterAddress);
  assert.equal(await adapter.market(), marketAddress);
  assert.equal(await adapter.oov3(), oracleAddress);
  assert.equal(await adapter.bondCurrency(), bondAddress);
  assert.equal(await adapter.identifier(), await oracle.defaultIdentifier());
  assert.equal(await adapter.bondAmount(), policyBond);
  assert.equal(await oracle.isWhitelisted(bondAddress), true);
  assert.equal(await oracle.getMinimumBond(bondAddress), minimumBond);
  assert.equal(await bond.decimals(), BigInt(bondDecimals));
  assert.equal(await market.metricCount(), 0n);
  assert.equal(await market.marketCount(), 0n);

  async function describe(
    name: string,
    contract: BaseContract,
    constructorArguments: (string | number)[],
  ): Promise<MetricContractDeployment> {
    const transaction = contract.deploymentTransaction();
    assert.ok(transaction, name + ": no deployment transaction");
    const receipt = await transaction.wait();
    assert.equal(receipt?.status, 1);
    assert.ok(receipt);
    const address = await contract.getAddress();
    const code = await ethers.provider.getCode(address);
    assert.notEqual(code, "0x", name + ": empty runtime code");
    const artifact = await hre.artifacts.readArtifact(name);
    return {
      address,
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
      constructorArguments,
      abiKeccak256: keccak256(toUtf8Bytes(JSON.stringify(artifact.abi))),
      runtimeCodeKeccak256: keccak256(code),
    };
  }

  const manifest: MetricDeploymentManifest = {
    schemaVersion: 1,
    product: "rainpool-metric-v1",
    environment: "LOCAL_MOCK",
    network: "localhost",
    chainId: 31337,
    publicRpcUrl: "http://127.0.0.1:8545",
    deployedAt: new Date().toISOString(),
    admin: adminAddress,
    contracts: {
      TestBondToken: await describe("TestBondToken", bond, ["Local metric test bond", "tBOND", bondDecimals]),
      MockOptimisticOracleV3: await describe("MockOptimisticOracleV3", oracle, [adminAddress]),
      PredictionMarket: await describe("PredictionMarket", market, [adminAddress]),
      UmaMetricOracleAdapter: await describe("UmaMetricOracleAdapter", adapter, [
        oracleAddress, marketAddress, bondAddress, policyBond.toString(),
      ]),
    },
    bindingTransactionHash: binding.hash,
    oracle: {
      optimisticOracleV3: oracleAddress,
      bondCurrency: bondAddress,
      bondSymbol: await bond.symbol(),
      bondDecimals,
      policyBond: policyBond.toString(),
      minimumBond: minimumBond.toString(),
      identifier: await adapter.identifier(),
      note: "LOCAL_MOCK: disputes use simulated answers; this is not a real UMA/DVM result.",
    },
  };

  await mkdir("deployments", { recursive: true });
  await writeFile(METRIC_MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({
    wrote: METRIC_MANIFEST_FILE,
    chainId,
    admin: adminAddress,
    contracts: Object.fromEntries(Object.entries(manifest.contracts).map(([name, entry]) => [name, entry.address])),
    bindingVerified: true,
    metricCount: 0,
    marketCount: 0,
  }, null, 2));
} finally {
  await connection.close();
}
