import { readFileSync } from "node:fs";
import { expect } from "chai";
import { Contract, encodeBytes32String, keccak256, sha256, toUtf8Bytes, toUtf8String } from "ethers";
import { network } from "hardhat";
import { buildCustomNumericRules, customMetricRulesDocument } from "../../src/metric/custom-profile.js";
import { buildCustomNumericProposal } from "../../src/metric/numeric-proposals.js";

// Only an in-process fork is used. None of these signers can send to public Sepolia.
const connection = await network.create("sepoliaFork");
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;
const cfg = JSON.parse(readFileSync("config/uma-sepolia.json", "utf8")) as {
  optimisticOracleV3: string;
  selectedBondCurrency: string;
  expected: { identifier: string; runtimeCodeKeccak256: string };
};
const OOV3 = cfg.optimisticOracleV3;
const TEST6 = cfg.selectedBondCurrency;
const POLICY_BOND = 1_000_000n;
const YES_STAKE = ethers.parseEther("0.01");
const NO_STAKE = ethers.parseEther("0.02");
const LIVENESS = 7_200;
const TOKEN_ABI = [
  "function mint(address to,uint256 amount)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
// A custom weather metric: the change in mean sea-level pressure over a short window, read from a document.
const custom = customMetricRulesDocument({
  code: "PRESSURE_CHANGE", unit: "hPa", minValue: -50_000, maxValue: 50_000, valueStep: 10, allowsTrace: false,
  interpretation: "Change in mean sea-level pressure at HKO headquarters over the market observation window, in hPa.",
});
const metric = {
  ...custom.definition, code: encodeBytes32String(custom.definition.code), unit: encodeBytes32String(custom.definition.unit),
  rulesHash: custom.rulesHash,
};
const SOURCE = {
  sourceName: "Pressure log", sourceUrl: "https://example.org/pressure-log",
  procedure: "Subtract the first hourly mean sea-level pressure in the window from the last one, in hPa.",
};
const gas: Record<string, bigint> = {};

async function deployOnFork() {
  const [admin, proposer, yesUser, noUser, disputer] = await ethers.getSigners();
  if (!admin || !proposer || !yesUser || !noUser || !disputer) throw new Error("Five local fork accounts are required");
  const market = await ethers.deployContract("PredictionMarket", [admin.address], admin);
  const adapter = await ethers.deployContract("UmaMetricOracleAdapter", [OOV3, market, TEST6, POLICY_BOND], admin);
  const oracle = await ethers.getContractAt("IOptimisticOracleV3", OOV3);
  await (await market.setOracleAdapter(adapter)).wait();
  await (await market.registerMetric(metric)).wait();
  const bond = await adapter.bondAmount();
  for (const [signer, spender] of [[proposer, adapter], [disputer, oracle]] as const) {
    const token = new Contract(TEST6, TOKEN_ABI, signer);
    // The real 6TEST public mint is called only on the local fork.
    await (await token.getFunction("mint")(signer.address, 10n * bond)).wait();
    await (await token.getFunction("approve")(await spender.getAddress(), 10n * bond)).wait();
  }
  return {
    admin, proposer, yesUser, noUser, disputer, market, adapter, oracle, bond,
    token: new Contract(TEST6, TOKEN_ABI, ethers.provider),
  };
}
type Fixture = Awaited<ReturnType<typeof deployOnFork>>;

async function twoSidedMarket(f: Fixture) {
  const now = await time.latest();
  // Snapshot 恢复后也明确固定下一块，避免 RPC 等待期间墙钟推进让 openAt 过期。
  await time.setNextBlockTimestamp(now + 1);
  const config = {
    proposer: f.proposer.address,
    sourceId: encodeBytes32String("PRESSURE_LOG"),
    subjectId: encodeBytes32String("PRESSURE_CHANGE"),
    condition: { metricId: 1, comparison: 3, lower: 0, upper: 0 },
    times: {
      openAt: now + 60, closeAt: now + 300,
      observationStart: now + 300, observationEnd: now + 600,
      earliestAssertionAt: now + 600, proposalCutoff: now + 4_200,
      // The market requires at least a one-hour settle window after the latest expiry.
      refundAt: now + 4_200 + LIVENESS + 3_600, assertionLiveness: LIVENESS,
    },
  };
  // Creation fixes the source and the reading procedure. The reading and its hash come later.
  const rulesDocument = buildCustomNumericRules({
    title: "Pressure change greater than zero?", ...SOURCE, metricRulesDocument: custom.rulesDocument,
  }, { config, metricId: 1, metric: await f.market.getMetric(1) });
  const receipt = await (await f.market.createMarket(config, toUtf8Bytes(rulesDocument))).wait();
  gas.createMarket = receipt?.gasUsed ?? 0n;
  const id = await f.market.marketCount();
  console.log(`      created numeric market ${id}; staking and advancing its local observation window`);
  expect(await f.market.marketRulesHash(id)).to.equal(keccak256(toUtf8Bytes(rulesDocument)));
  await time.increaseTo(config.times.openAt);
  gas.firstBet = (await (await f.market.connect(f.yesUser).bet(id, 1, { value: YES_STAKE })).wait())?.gasUsed ?? 0n;
  await (await f.market.connect(f.noUser).bet(id, 2, { value: NO_STAKE })).wait();
  await time.increaseTo(config.times.earliestAssertionAt);
  return { id, config, rulesDocument };
}
type CreatedMarket = Awaited<ReturnType<typeof twoSidedMarket>>;

async function propose(f: Fixture, created: CreatedMarket) {
  const capturedAt = await time.latest();
  // A test document for the forked oracle flow. It is not a real pressure reading.
  const raw = toUtf8Bytes("Test pressure log: 08:00 1009.0 hPa, 11:00 1010.0 hPa");
  const config = await f.market.getMarketConfig(created.id);
  const proposal = buildCustomNumericProposal({ rawBytes: raw, reading: "1.0", capturedAt }, {
    rulesDocument: created.rulesDocument,
    chainTimestamp: capturedAt,
    expected: {
      config, metricId: config.condition.metricId,
      metric: await f.market.getMetric(config.condition.metricId),
      marketRulesHash: await f.market.marketRulesHash(created.id),
    },
  });
  const preview = await f.adapter.connect(f.proposer).previewClaim(created.id, proposal.reading, proposal.evidence);
  console.log(`      proposing market ${created.id} to the real forked OOV3`);
  // 分叉节点的自动估气可能长时间等待。此上限仅用于本地执行验证，
  // 它不代表已验证公开网络/前端的 estimateGas 路径，实际 gasUsed 另行输出。
  const tx = await f.adapter.connect(f.proposer).propose(
    created.id, proposal.reading, proposal.evidence, f.bond, { gasLimit: 3_000_000 },
  );
  console.log(`      submitted local fork transaction ${tx.hash}`);
  // EDR automines. Read once instead of polling indefinitely if a nonce is wrong.
  const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
  if (!receipt) {
    const nonce = await ethers.provider.send("eth_getTransactionCount", [f.proposer.address, "pending"]);
    throw new Error(`Local assertion transaction was not mined: hash=${tx.hash}, nonce=${tx.nonce}, pendingNonce=${nonce}`);
  }
  gas.propose = receipt?.gasUsed ?? 0n;
  const id = await f.adapter.assertionOfMarket(created.id);
  console.log(`      real assertion ${id}`);
  const made = receipt?.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== OOV3.toLowerCase()) return [];
    try {
      const parsed = f.oracle.interface.parseLog(log);
      return parsed?.name === "AssertionMade" ? [parsed] : [];
    } catch { return []; }
  }) ?? [];
  expect(made).to.have.length(1);
  expect(made[0]!.args.assertionId).to.equal(id);
  expect(made[0]!.args.claim).to.equal(preview);
  await expect(tx).to.emit(f.adapter, "EvidencePublished")
    .withArgs(created.id, id, sha256(raw), capturedAt, proposal.evidence.sourceUrl, ethers.hexlify(raw));
  return { id, claim: toUtf8String(preview) };
}

describe("Sepolia fork: generic numeric market with the real UMA OOV3", function () {
  before(async function () {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("The fork must return a latest block");
    console.log(`      fork block ${block.number}, chain timestamp ${block.timestamp}, hash ${block.hash}`);
  });
  after(async function () {
    console.log(`      gasUsed: ${Object.entries(gas).map(([name, value]) => `${name} ${value}`).join(", ")}`);
    await connection.close();
  });

  it("checks canonical bytecode, a supported default identifier and whitelisted 6TEST bond policy", async function () {
    expect((await ethers.provider.getNetwork()).chainId).to.equal(11155111n);
    expect(keccak256(await ethers.provider.getCode(OOV3))).to.equal(cfg.expected.runtimeCodeKeccak256);
    const oracle = await ethers.getContractAt("IOptimisticOracleV3", OOV3);
    const identifier = await oracle.defaultIdentifier();
    expect(identifier).to.equal(encodeBytes32String(cfg.expected.identifier));
    const extendedOracle = new Contract(OOV3, ["function finder() view returns(address)"], ethers.provider);
    const finder = new Contract(await extendedOracle.getFunction("finder")(), [
      "function getImplementationAddress(bytes32) view returns(address)",
    ], ethers.provider);
    const identifierWhitelist = new Contract(
      await finder.getFunction("getImplementationAddress")(encodeBytes32String("IdentifierWhitelist")),
      ["function isIdentifierSupported(bytes32) view returns(bool)"], ethers.provider,
    );
    const collateralWhitelist = new Contract(
      await finder.getFunction("getImplementationAddress")(encodeBytes32String("CollateralWhitelist")),
      ["function isOnWhitelist(address) view returns(bool)"], ethers.provider,
    );
    // 不支持即失败。不跳过，也不改用 Mock 或另一个 identifier 掩盖部署条件。
    expect(await identifierWhitelist.getFunction("isIdentifierSupported")(identifier), "default identifier must remain supported").to.equal(true);
    expect(await collateralWhitelist.getFunction("isOnWhitelist")(TEST6)).to.equal(true);
    const token = new Contract(TEST6, TOKEN_ABI, ethers.provider);
    expect(await token.getFunction("symbol")()).to.equal("6TEST");
    expect(await token.getFunction("decimals")()).to.equal(6n);
    const minimum = await oracle.getMinimumBond(TEST6);
    expect(minimum, "recheck policy if the pinned Sepolia minimum changes").to.equal(0n);
    const f = await networkHelpers.loadFixture(deployOnFork);
    expect(await f.adapter.identifier()).to.equal(identifier);
    expect(f.bond).to.equal(POLICY_BOND);
    console.log(`      identifier ${toUtf8String(identifier).replaceAll("\0", "")}; minimum bond ${minimum}; policy bond ${f.bond}`);
  });

  it("rejects a noncanonical oracle on chainId 11155111", async function () {
    const f = await networkHelpers.loadFixture(deployOnFork);
    const adapterFactory = await ethers.getContractFactory("UmaMetricOracleAdapter");
    await expect(adapterFactory.deploy(f.market, f.market, TEST6, POLICY_BOND))
      .to.be.revertedWithCustomError(f.adapter, "NotCanonicalOracle").withArgs(await f.market.getAddress());
  });

  it("rejects any bond currency but the pinned 6TEST, and a zero policy bond, on chainId 11155111", async function () {
    const f = await networkHelpers.loadFixture(deployOnFork);
    const adapterFactory = await ethers.getContractFactory("UmaMetricOracleAdapter");
    await expect(adapterFactory.deploy(OOV3, f.market, f.market, POLICY_BOND))
      .to.be.revertedWithCustomError(f.adapter, "NotPinnedBondCurrency").withArgs(await f.market.getAddress());
    await expect(adapterFactory.deploy(OOV3, f.market, TEST6, 0))
      .to.be.revertedWithCustomError(f.adapter, "ZeroPolicyBond");
    expect(await f.adapter.SEPOLIA_BOND_CURRENCY()).to.equal(TEST6);
  });

  it("submits a numeric reading, waits real OO liveness, receives its callback, returns the bond and pays the winner", async function () {
    const f = await networkHelpers.loadFixture(deployOnFork);
    const created = await twoSidedMarket(f);
    const bondBefore = await f.token.getFunction("balanceOf")(f.proposer.address) as bigint;
    const { id, claim } = await propose(f, created);
    const assertion = await f.oracle.getAssertion(id);
    expect([
      assertion.asserter, assertion.callbackRecipient, assertion.bond,
      assertion.expirationTime - assertion.assertionTime, assertion.identifier,
    ]).to.deep.equal([
      f.proposer.address, await f.adapter.getAddress(), f.bond,
      BigInt(LIVENESS), await f.oracle.defaultIdentifier(),
    ]);
    expect(claim).to.contain("protocol=NUMERIC_OBSERVATION_V1")
      .and.to.contain("value100=100")
      .and.to.contain("chainId=11155111")
      .and.to.contain(`market=${(await f.market.getAddress()).toLowerCase()}`)
      .and.to.contain(`marketRulesHash=${keccak256(toUtf8Bytes(created.rulesDocument))}`);
    expect(await f.token.getFunction("balanceOf")(f.proposer.address)).to.equal(bondBefore - f.bond);
    await time.increaseTo(assertion.expirationTime);
    const tx = f.adapter.settle(id);
    await expect(tx).to.emit(f.market, "MarketResolved").withArgs(created.id, 1, id, 1, 100);
    gas.settleWithCallback = (await (await tx).wait())?.gasUsed ?? 0n;
    expect((await f.market.getEffectiveState(created.id)).terminal).to.equal(1n);
    expect(await f.oracle.getAssertionResult(id)).to.equal(true);
    expect(await f.token.getFunction("balanceOf")(f.proposer.address)).to.equal(bondBefore);
    const total = YES_STAKE + NO_STAKE;
    const claimTx = f.market.connect(f.yesUser).claim(created.id);
    await expect(claimTx).to.changeEtherBalances(ethers, [f.yesUser, f.market], [total, -total]);
    gas.claim = (await (await claimTx).wait())?.gasUsed ?? 0n;
    expect((await f.market.getMarketState(created.id)).paidOut).to.equal(total);
    expect((await f.market.getPosition(created.id, f.yesUser.address)).claimed).to.equal(true);
  });

  it("records a real dispute and refunds stakes at the fixed deadline while the DVM answer is pending", async function () {
    const f = await networkHelpers.loadFixture(deployOnFork);
    const created = await twoSidedMarket(f);
    const { id } = await propose(f, created);
    // 同样只验证本地分叉执行。不把估气行为包含在此回归结论中。
    await expect(f.oracle.connect(f.disputer).disputeAssertion(id, f.disputer.address, { gasLimit: 3_000_000 }))
      .to.emit(f.adapter, "DisputeCallbackReceived").withArgs(created.id, id);
    expect((await f.market.getAssertion(created.id)).disputed).to.equal(true);
    expect((await f.oracle.getAssertion(id)).disputer).to.equal(f.disputer.address);
    expect((await f.market.getEffectiveState(created.id)).terminal).to.equal(0n);
    await time.increaseTo(created.config.times.refundAt);
    await expect(f.adapter.settle(id)).to.revert(ethers);
    expect((await f.oracle.getAssertion(id)).settled).to.equal(false);
    await expect(f.market.connect(f.noUser).claim(created.id))
      .to.emit(f.market, "MarketRefundActivated").withArgs(created.id, 3, f.noUser.address)
      .and.to.emit(f.market, "Claimed").withArgs(created.id, f.noUser.address, NO_STAKE, 1);
    await expect(f.market.connect(f.yesUser).claim(created.id))
      .to.changeEtherBalances(ethers, [f.yesUser, f.market], [YES_STAKE, -YES_STAKE]);
    expect((await f.market.getMarketState(created.id)).paidOut).to.equal(YES_STAKE + NO_STAKE);
    // 退款的是下注 ETH。有争议的 UMA 保证金仍由真实 OO/DVM 保管。
    expect((await f.market.getEffectiveState(created.id)).terminal).to.equal(3n);
  });

  it("settles a matured undisputed assertion after refundAt instead of refunding, and returns the bond", async function () {
    const f = await networkHelpers.loadFixture(deployOnFork);
    const created = await twoSidedMarket(f);
    const before = await f.token.getFunction("balanceOf")(f.proposer.address);
    const { id } = await propose(f, created);
    await time.increaseTo(created.config.times.refundAt);
    // Settle first: no refund can start while the undisputed assertion is pending.
    await expect(f.market.connect(f.noUser).claim(created.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
    await expect(f.adapter.settle(id)).to.emit(f.market, "MarketResolved").withArgs(created.id, 1, id, 1, 100);
    expect(await f.oracle.getAssertionResult(id)).to.equal(true);
    expect(await f.token.getFunction("balanceOf")(f.proposer.address)).to.equal(before);
    expect((await f.market.getEffectiveState(created.id)).terminal).to.equal(1n);
    const total = YES_STAKE + NO_STAKE;
    await expect(f.market.connect(f.yesUser).claim(created.id))
      .to.emit(f.market, "Claimed").withArgs(created.id, f.yesUser.address, total, 0);
    expect((await f.market.getMarketState(created.id)).paidOut).to.equal(total);
  });
});
