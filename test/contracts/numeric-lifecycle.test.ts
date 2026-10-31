import { expect } from "chai";
import { network } from "hardhat";
import { payoutIfWins } from "../../src/metric/payout.js";

// This connection is an isolated Hardhat test network, never the user's localhost.
const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;
const BOND = ethers.parseUnits("10", 6);
const MIN = ethers.parseEther("0.001");
// PredictionMarket.MIN_SETTLE_WINDOW: refundAt >= proposalCutoff + liveness + 1 hour.
const SETTLE_WINDOW = 3600;
const HASH = ethers.keccak256(ethers.toUtf8Bytes("synthetic lifecycle test"));
const RULES = ethers.toUtf8Bytes(JSON.stringify({
  synthetic: true,
  protocol: "NUMERIC_OBSERVATION_V1",
  procedure: "After observationEnd the designated test proposer publishes a synthetic numeric reading.",
  finality: "Only a truthful Mock oracle callback accepts the reading; a rejection refunds the market.",
}));
const signedMetric = {
  code: ethers.encodeBytes32String("SIGNED_TEST"),
  unit: ethers.encodeBytes32String("points"),
  minValue: -1000, maxValue: 1000, valueStep: 10, allowsTrace: false, rulesHash: HASH,
};
const rainfallMetric = {
  code: ethers.encodeBytes32String("RAIN_TEST"),
  unit: ethers.encodeBytes32String("mm"),
  minValue: 0, maxValue: 100000, valueStep: 10, allowsTrace: true, rulesHash: HASH,
};
const numeric = (value: number) => ({ kind: 1, value });
const trace = { kind: 2, value: 0 };
type Condition = { metricId: number; comparison: number; lower: number; upper: number };
const greaterThanZero: Condition = { metricId: 1, comparison: 3, lower: 0, upper: 0 };

async function unboundFixture() {
  const [admin, proposer, alice, bob, carol, outsider, store] = await ethers.getSigners();
  if (!admin || !proposer || !alice || !bob || !carol || !outsider || !store) {
    throw new Error("This test requires seven accounts");
  }
  const token = await ethers.deployContract("TestBondToken", ["Lifecycle bond", "tBOND", 6]);
  const oracle = await ethers.deployContract("MockOptimisticOracleV3", [store.address]);
  const market = await ethers.deployContract("PredictionMarket", [admin.address]);
  const adapter = await ethers.deployContract("UmaMetricOracleAdapter", [oracle, market, token, BOND]);
  await (await oracle.setCurrency(token, true, BOND)).wait();
  await (await token.mint(proposer, 4n * BOND)).wait();
  await (await token.connect(proposer).approve(adapter, 4n * BOND)).wait();
  return { admin, proposer, alice, bob, carol, outsider, store, token, oracle, market, adapter };
}

async function fixture() {
  const f = await unboundFixture();
  await (await f.market.setOracleAdapter(f.adapter)).wait();
  await (await f.market.registerMetric(signedMetric)).wait();
  await (await f.market.registerMetric(rainfallMetric)).wait();
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function configFor(f: Fixture, condition = greaterThanZero) {
  const now = await time.latest();
  return {
    proposer: f.proposer.address,
    sourceId: ethers.encodeBytes32String("SYNTHETIC_TEST"),
    subjectId: ethers.encodeBytes32String("LIFECYCLE"),
    condition: { ...condition },
    times: {
      openAt: now + 60, closeAt: now + 600,
      observationStart: now + 600, observationEnd: now + 900,
      earliestAssertionAt: now + 900, proposalCutoff: now + 1500,
      refundAt: now + 1500 + 60 + SETTLE_WINDOW, assertionLiveness: 60,
    },
  };
}
async function create(f: Fixture, condition = greaterThanZero) {
  const config = await configFor(f, condition);
  await (await f.market.createMarket(config, RULES)).wait();
  return { id: await f.market.marketCount(), config };
}
type Created = Awaited<ReturnType<typeof create>>;

async function openBoth(f: Fixture, created: Created, yesStake = MIN, noStake = 2n * MIN) {
  await time.increaseTo(created.config.times.openAt);
  await (await f.market.connect(f.alice).bet(created.id, 1, { value: yesStake })).wait();
  await (await f.market.connect(f.bob).bet(created.id, 2, { value: noStake })).wait();
}

async function propose(f: Fixture, created: Created, value = 10) {
  await time.increaseTo(created.config.times.earliestAssertionAt);
  const raw = ethers.toUtf8Bytes(JSON.stringify({ synthetic: true, value100: value }));
  await (await f.adapter.connect(f.proposer).propose(created.id, numeric(value), {
    sourceUrl: "test:synthetic-lifecycle",
    rawSha256: ethers.sha256(raw),
    capturedAt: await time.latest(),
    excerpt: raw,
  }, BOND)).wait();
  return await f.adapter.assertionOfMarket(created.id);
}

async function settle(f: Fixture, assertionId: string) {
  const assertion = await f.oracle.getAssertion(assertionId);
  await time.increaseTo(assertion.expirationTime);
  return f.adapter.connect(f.outsider).settle(assertionId);
}

describe("Numeric market lifecycle and funds boundaries", function () {
  after(async function () { await connection.close(); });

  it("requires an administrator and limits registry, creation, and binding to that administrator", async function () {
    const f = await networkHelpers.loadFixture(unboundFixture);
    await expect(ethers.deployContract("PredictionMarket", [ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(f.market, "InvalidMetricAdmin");
    await expect(f.market.connect(f.outsider).registerMetric(signedMetric))
      .to.be.revertedWithCustomError(f.market, "OnlyMetricAdmin");
    await expect(f.market.connect(f.outsider).setOracleAdapter(f.adapter))
      .to.be.revertedWithCustomError(f.market, "OnlyMetricAdmin");
    const config = await configFor(f);
    await expect(f.market.connect(f.outsider).createMarket(config, RULES))
      .to.be.revertedWithCustomError(f.market, "OnlyMetricAdmin");
    await expect(f.market.createMarket(config, RULES))
      .to.be.revertedWithCustomError(f.market, "OracleAdapterNotSet");
    expect(await f.market.metricCount()).to.equal(0n);
    expect(await f.market.marketCount()).to.equal(0n);
  });

  it("binds once to a contract that points back to this specific market", async function () {
    const f = await networkHelpers.loadFixture(unboundFixture);
    for (const address of [ethers.ZeroAddress, f.outsider.address]) {
      await expect(f.market.setOracleAdapter(address))
        .to.be.revertedWithCustomError(f.market, "InvalidOracleAdapter");
    }
    const otherMarket = await ethers.deployContract("PredictionMarket", [f.admin.address]);
    await expect(otherMarket.setOracleAdapter(f.adapter))
      .to.be.revertedWithCustomError(otherMarket, "InvalidOracleAdapter");
    await expect(f.market.setOracleAdapter(f.adapter))
      .to.emit(f.market, "OracleAdapterSet").withArgs(await f.adapter.getAddress());
    await expect(f.market.setOracleAdapter(f.adapter))
      .to.be.revertedWithCustomError(f.market, "OracleAdapterAlreadySet");
  });

  it("rejects malformed registry entries without allocating identifiers", async function () {
    const f = await networkHelpers.loadFixture(unboundFixture);
    const invalid = [
      { code: ethers.ZeroHash }, { unit: ethers.ZeroHash }, { rulesHash: ethers.ZeroHash },
      { minValue: 20, maxValue: 10 }, { valueStep: 0 },
      { minValue: 1, maxValue: 9, valueStep: 10 },
      { minValue: -9, maxValue: -1, valueStep: 10 },
    ];
    for (const patch of invalid) {
      await expect(f.market.registerMetric({ ...signedMetric, ...patch }))
        .to.be.revertedWithCustomError(f.market, "InvalidMetricDefinition");
    }
    expect(await f.market.metricCount()).to.equal(0n);
    await (await f.market.registerMetric({ ...signedMetric, minValue: -19, maxValue: -1 })).wait();
    expect(await f.market.metricCount()).to.equal(1n);
    expect((await f.market.getMetric(1)).minValue).to.equal(-19n);
    await expect(f.market.registerMetric(signedMetric))
      .to.be.revertedWithCustomError(f.market, "DuplicateMetricCode").withArgs(signedMetric.code);
    expect(await f.market.metricCount()).to.equal(1n);
    for (const id of [0, 2]) {
      await expect(f.market.getMetric(id)).to.be.revertedWithCustomError(f.market, "UnknownMetric").withArgs(id);
    }
  });

  it("rejects empty identities, unknown metrics, and ambiguous comparison configurations", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const config = await configFor(f);
    for (const patch of [
      { proposer: ethers.ZeroAddress }, { sourceId: ethers.ZeroHash }, { subjectId: ethers.ZeroHash },
    ]) {
      await expect(f.market.createMarket({ ...config, ...patch }, RULES))
        .to.be.revertedWithCustomError(f.market, "InvalidMarketConfig").withArgs("empty field");
    }
    for (const metricId of [0, 3]) {
      await expect(f.market.createMarket({ ...config, condition: { ...config.condition, metricId } }, RULES))
        .to.be.revertedWithCustomError(f.market, "UnknownMetric").withArgs(metricId);
    }
    for (const condition of [
      { ...config.condition, comparison: 0 },
      { ...config.condition, upper: 1 },
      { ...config.condition, comparison: 5, lower: 20, upper: 10 },
    ]) {
      await expect(f.market.createMarket({ ...config, condition }, RULES))
        .to.be.revertedWithCustomError(f.market, "InvalidCondition");
    }
    expect(await f.market.marketCount()).to.equal(0n);
  });

  it("requires ordered windows, a 60 s liveness and a one-hour settle window", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    expect(await f.market.MIN_LIVENESS()).to.equal(60n);
    expect(await f.market.MIN_SETTLE_WINDOW()).to.equal(BigInt(SETTLE_WINDOW));
    const config = await configFor(f);
    const t = config.times;
    const invalidOrder = [
      { openAt: 0 }, { closeAt: t.openAt }, { observationStart: t.closeAt - 1 },
      { observationEnd: t.observationStart }, { earliestAssertionAt: t.observationEnd - 1 },
      { proposalCutoff: t.earliestAssertionAt }, { refundAt: t.proposalCutoff },
    ];
    for (const patch of invalidOrder) {
      await expect(f.market.createMarket({ ...config, times: { ...t, ...patch } }, RULES))
        .to.be.revertedWithCustomError(f.market, "InvalidMarketConfig").withArgs("time order");
    }
    for (const assertionLiveness of [0, 59]) {
      await expect(f.market.createMarket({ ...config, times: { ...t, assertionLiveness } }, RULES))
        .to.be.revertedWithCustomError(f.market, "InvalidMarketConfig").withArgs("assertion liveness");
    }
    for (const times of [
      { ...t, refundAt: t.proposalCutoff + t.assertionLiveness + SETTLE_WINDOW - 1 },
      { ...t, assertionLiveness: t.refundAt - t.proposalCutoff },
      { ...t, assertionLiveness: t.assertionLiveness + 1 },
    ]) {
      await expect(f.market.createMarket({ ...config, times }, RULES))
        .to.be.revertedWithCustomError(f.market, "InvalidMarketConfig").withArgs("settlement buffer");
    }
    // Equality at close/start and observationEnd/earliest is intentionally allowed;
    // configFor already uses the smallest refundAt the settle window permits.
    expect(t.refundAt).to.equal(t.proposalCutoff + 60 + SETTLE_WINDOW);
    await (await f.market.createMarket(config, RULES)).wait();
    expect(await f.market.marketCount()).to.equal(1n);
  });

  it("enforces rule byte limits and commits exact bytes without parsing them", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const config = await configFor(f);
    for (const document of ["0x", ethers.hexlify(new Uint8Array(4097))]) {
      await expect(f.market.createMarket(config, document))
        .to.be.revertedWithCustomError(f.market, "BadRulesDocument");
    }
    const exact = new Uint8Array(4096).fill(0x61);
    await expect(f.market.createMarket(config, exact)).to.emit(f.market, "MarketCreated")
      .withArgs(1, 1, f.proposer.address, ethers.keccak256(exact), ethers.hexlify(exact));
    expect(await f.market.marketRulesHash(1)).to.equal(ethers.keccak256(exact));
    // Application rule validation lives off-chain. This byte-limit test is not a valid production rule document.
  });

  it("rejects unknown market identifiers consistently across reads and writes", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const operations = [
      () => f.market.getMarketConfig(1), () => f.market.getMarketState(1),
      () => f.market.getPosition(1, f.alice), () => f.market.getAssertion(1),
      () => f.market.claimable(1, f.alice), () => f.market.activateRefund(1),
      () => f.market.connect(f.alice).bet(1, 1, { value: MIN }),
    ];
    for (const operation of operations) {
      await expect(operation()).to.be.revertedWithCustomError(f.market, "UnknownMarket").withArgs(1);
    }
  });

  it("accepts bets at openAt, rejects them at closeAt, and rejects invalid side or dust", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await time.increaseTo(m.config.times.openAt - 1);
    await expect(f.market.connect(f.alice).bet.staticCall(m.id, 1, { value: MIN }))
      .to.be.revertedWithCustomError(f.market, "BettingNotOpen").withArgs(m.config.times.openAt);
    await time.increaseTo(m.config.times.openAt);
    await f.market.connect(f.alice).bet.staticCall(m.id, 1, { value: MIN });
    await expect(f.market.connect(f.alice).bet(m.id, 0, { value: MIN }))
      .to.be.revertedWithCustomError(f.market, "InvalidSide");
    await expect(f.market.connect(f.alice).bet(m.id, 1, { value: MIN - 1n }))
      .to.be.revertedWithCustomError(f.market, "BetTooSmall").withArgs(MIN - 1n, MIN);
    await (await f.market.connect(f.alice).bet(m.id, 1, { value: MIN })).wait();
    await time.increaseTo(m.config.times.closeAt);
    await expect(f.market.connect(f.bob).bet.staticCall(m.id, 2, { value: MIN }))
      .to.be.revertedWithCustomError(f.market, "BettingClosed").withArgs(m.config.times.closeAt);
    expect(await ethers.provider.getBalance(f.market)).to.equal(MIN);
  });

  it("adds same-side stakes once per account while preventing a side switch only in that market", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const one = await create(f);
    const two = await create(f);
    await time.increaseTo(two.config.times.openAt);
    await (await f.market.connect(f.alice).bet(one.id, 1, { value: MIN })).wait();
    await (await f.market.connect(f.alice).bet(one.id, 1, { value: 2n * MIN })).wait();
    await expect(f.market.connect(f.alice).bet(one.id, 2, { value: MIN }))
      .to.be.revertedWithCustomError(f.market, "SideLocked").withArgs(1);
    await (await f.market.connect(f.alice).bet(two.id, 2, { value: MIN })).wait();
    const state = await f.market.getMarketState(one.id);
    expect([state.yesTotal, state.noTotal, state.yesAccounts, state.noAccounts]).to.deep.equal([3n * MIN, 0n, 1n, 0n]);
    expect((await f.market.getPosition(one.id, f.alice)).stake).to.equal(3n * MIN);
    expect((await f.market.getPosition(two.id, f.alice)).side).to.equal(2n);
    expect(await ethers.provider.getBalance(f.market)).to.equal(4n * MIN);
  });

  it("does not allow any withdrawal or refund before a market is final or refundable", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m);
    expect(await f.market.claimable(m.id, f.alice)).to.equal(0n);
    expect(await f.market.claimable(m.id, f.outsider)).to.equal(0n);
    for (const user of [f.alice, f.outsider]) {
      await expect(f.market.connect(user).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
    }
    await expect(f.market.activateRefund(m.id)).to.be.revertedWithCustomError(f.market, "RefundNotAvailable");
    expect((await f.market.getPosition(m.id, f.alice)).claimed).to.equal(false);
    expect(await ethers.provider.getBalance(f.market)).to.equal(3n * MIN);
  });

  it("marks an empty market refundable at close without creating a claim for nonparticipants", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await time.increaseTo(m.config.times.closeAt);
    expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([3n, 1n]);
    await expect(f.market.connect(f.outsider).activateRefund(m.id))
      .to.emit(f.market, "MarketRefundActivated").withArgs(m.id, 1, f.outsider.address);
    await expect(f.market.connect(f.outsider).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
    await expect(f.market.activateRefund(m.id)).to.be.revertedWithCustomError(f.market, "MarketFinal").withArgs(3);
  });

  for (const side of [1, 2]) {
    it(`refunds an exclusively ${side === 1 ? "YES" : "NO"} market from closeAt and rejects duplicate claims`, async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await time.increaseTo(m.config.times.openAt);
      await (await f.market.connect(f.alice).bet(m.id, side, { value: 2n * MIN })).wait();
      await time.increaseTo(m.config.times.closeAt);
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([3n, 2n]);
      expect(await f.market.claimable(m.id, f.alice)).to.equal(2n * MIN);
      const tx = f.market.connect(f.alice).claim(m.id);
      await expect(tx).to.changeEtherBalances(ethers, [f.market, f.alice], [-2n * MIN, 2n * MIN]);
      await expect(tx).to.emit(f.market, "Claimed").withArgs(m.id, f.alice.address, 2n * MIN, 1);
      expect((await f.market.getMarketState(m.id)).refundReason).to.equal(2n);
      expect((await f.market.getPosition(m.id, f.alice)).claimed).to.equal(true);
      expect(await f.market.claimable(m.id, f.alice)).to.equal(0n);
      await expect(f.market.connect(f.alice).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
      await expect(f.market.connect(f.bob).bet(m.id, 3 - side, { value: MIN }))
        .to.be.revertedWithCustomError(f.market, "MarketFinal").withArgs(3);
    });
  }

  it("refunds both sides at refundAt when no result was submitted", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m);
    await time.increaseTo(m.config.times.refundAt - 1);
    await expect(f.market.activateRefund.staticCall(m.id)).to.be.revertedWithCustomError(f.market, "RefundNotAvailable");
    expect(await f.market.claimable(m.id, f.alice)).to.equal(0n);
    await time.increaseTo(m.config.times.refundAt);
    expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([3n, 3n]);
    await (await f.market.connect(f.outsider).activateRefund(m.id)).wait();
    await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-MIN, MIN]);
    await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-2n * MIN, 2n * MIN]);
    expect((await f.market.getMarketState(m.id)).paidOut).to.equal(3n * MIN);
    expect(await ethers.provider.getBalance(f.market)).to.equal(0n);
    expect((await f.market.getAssertion(m.id)).assertionId).to.equal(ethers.ZeroHash);
  });

  it("pays multiple YES winners pro rata without allowing dust, losers, or repeated claims to drain funds", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m, MIN, MIN + 1n);
    await (await f.market.connect(f.carol).bet(m.id, 1, { value: 2n * MIN })).wait();
    const id = await propose(f, m);
    await (await settle(f, id)).wait();
    const aliceAmount = 1333333333333333n;
    const carolAmount = 2666666666666667n;
    expect(await f.market.claimable(m.id, f.alice)).to.equal(aliceAmount);
    expect(await f.market.claimable(m.id, f.carol)).to.equal(carolAmount);
    expect(await f.market.claimable(m.id, f.bob)).to.equal(0n);
    await expect(f.market.connect(f.bob).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
    await expect(f.market.connect(f.carol).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.carol], [-carolAmount, carolAmount]);
    await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-aliceAmount, aliceAmount]);
    await expect(f.market.connect(f.alice).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
    expect((await f.market.getMarketState(m.id)).paidOut).to.equal(4n * MIN);
    expect(await ethers.provider.getBalance(f.market)).to.equal(1n);
    await expect(f.market.activateRefund(m.id)).to.be.revertedWithCustomError(f.market, "MarketFinal").withArgs(1);
  });

  it("pays each winner exactly the shared payout estimate for the final totals", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await time.increaseTo(m.config.times.openAt);
    // Uneven stakes from four accounts so the floor division leaves dust; Alice's top-up is the last bet.
    const bets = [[f.alice, 1, MIN + 3n], [f.bob, 2, 2n * MIN + 345_678_901n], [f.carol, 1, MIN + 700_000_000_001n], [f.outsider, 2, MIN + 11n]] as const;
    for (const [who, side, value] of bets) await (await f.market.connect(who).bet(m.id, side, { value })).wait();
    const before = await f.market.getMarketState(m.id);
    const topUp = 3n * MIN + 7n;
    const aliceEstimate = payoutIfWins({
      yesTotal: before.yesTotal, noTotal: before.noTotal, side: "YES",
      stake: (await f.market.getPosition(m.id, f.alice)).stake, add: topUp,
    });
    await (await f.market.connect(f.alice).bet(m.id, 1, { value: topUp })).wait();
    await (await settle(f, await propose(f, m))).wait();
    const { yesTotal, noTotal } = await f.market.getMarketState(m.id);
    for (const who of [f.alice, f.carol]) {
      const { stake } = await f.market.getPosition(m.id, who);
      expect(await f.market.claimable(m.id, who)).to.equal(payoutIfWins({ yesTotal, noTotal, side: "YES", stake, add: 0n }));
    }
    // Nobody bet after Alice's top-up, so the estimate made before it is what she is paid.
    expect(await f.market.claimable(m.id, f.alice)).to.equal(aliceEstimate);
    expect(await f.market.claimable(m.id, f.bob)).to.equal(0n);
  });

  it("pays NO when an accepted reading misses the condition, because oracle truth is not a YES vote", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m);
    const id = await propose(f, m, 0);
    await expect(settle(f, id)).to.emit(f.market, "MarketResolved").withArgs(m.id, 2, id, 1, 0);
    expect(await f.market.claimable(m.id, f.alice)).to.equal(0n);
    expect(await f.market.claimable(m.id, f.bob)).to.equal(3n * MIN);
    await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-3n * MIN, 3n * MIN]);
    expect(await ethers.provider.getBalance(f.market)).to.equal(0n);
  });

  const numericConditions = [
    { name: "LT", comparison: 1, lower: 0, upper: 0, rows: [[-10, 1], [0, 2], [10, 2]] },
    { name: "LTE", comparison: 2, lower: 0, upper: 0, rows: [[-10, 1], [0, 1], [10, 2]] },
    { name: "GT", comparison: 3, lower: 0, upper: 0, rows: [[-10, 2], [0, 2], [10, 1]] },
    { name: "GTE", comparison: 4, lower: 0, upper: 0, rows: [[-10, 2], [0, 1], [10, 1]] },
    { name: "inclusive RANGE", comparison: 5, lower: -10, upper: 10, rows: [[-20, 2], [-10, 1], [0, 1], [10, 1], [20, 2]] },
  ];
  for (const item of numericConditions) {
    it(`evaluates ${item.name} on negative, exact-boundary, and positive readings`, async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f, { metricId: 1, comparison: item.comparison, lower: item.lower, upper: item.upper });
      await openBoth(f, m);
      await time.increaseTo(m.config.times.earliestAssertionAt);
      for (const [value, expected] of item.rows) {
        expect(await f.market.checkProposal(m.id, f.proposer, numeric(value!), HASH)).to.equal(BigInt(expected!));
      }
      expect((await f.market.getAssertion(m.id)).assertionId).to.equal(ethers.ZeroHash);
    });
  }

  // A 0.01 mm step lets thresholds fall inside the open Trace interval (0, 5).
  const fineTraceMetric = {
    ...rainfallMetric, code: ethers.encodeBytes32String("RAIN_FINE_TEST"), minValue: -100, valueStep: 1,
  };
  const traceConditions = [
    { name: "LT", comparison: 1, rows: [[0, 0, 2], [2, 0, 0], [5, 0, 1]] },
    { name: "LTE", comparison: 2, rows: [[0, 0, 2], [2, 0, 0], [5, 0, 1]] },
    { name: "GT", comparison: 3, rows: [[0, 0, 1], [2, 0, 0], [5, 0, 2]] },
    { name: "GTE", comparison: 4, rows: [[0, 0, 1], [2, 0, 0], [5, 0, 2]] },
    { name: "RANGE", comparison: 5, rows: [[-5, 0, 2], [5, 10, 2], [0, 5, 1], [0, 4, 0], [1, 5, 0]] },
  ];
  for (const item of traceConditions) {
    it(`treats Trace as an interval for ${item.name} and refuses conditions Trace cannot decide`, async function () {
      const f = await networkHelpers.loadFixture(fixture);
      await (await f.market.registerMetric(fineTraceMetric)).wait();
      const metricId = Number(await f.market.metricCount());
      const base = await configFor(f);
      const markets: Array<{ id: bigint; expected: number }> = [];
      for (const [lower, upper, expected] of item.rows) {
        const creation = f.market.createMarket({
          ...base, condition: { metricId, comparison: item.comparison, lower: lower!, upper: upper! },
        }, RULES);
        if (expected === 0) {
          await expect(creation).to.be.revertedWithCustomError(f.market, "IndeterminateTraceCondition");
          continue;
        }
        await (await creation).wait();
        markets.push({ id: await f.market.marketCount(), expected: expected! });
      }
      await time.increaseTo(base.times.openAt);
      for (const m of markets) {
        await (await f.market.connect(f.alice).bet(m.id, 1, { value: MIN })).wait();
        await (await f.market.connect(f.bob).bet(m.id, 2, { value: MIN })).wait();
      }
      await time.increaseTo(base.times.earliestAssertionAt);
      for (const m of markets) {
        expect(await f.market.checkProposal(m.id, f.proposer, trace, HASH)).to.equal(BigInt(m.expected));
      }
      expect(await f.token.balanceOf(f.proposer)).to.equal(4n * BOND);
    });
  }

  it("rejects a nonzero Trace placeholder and refuses to register unsupported Trace metrics", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const valid = await create(f, { ...greaterThanZero, metricId: 2 });
    for (const [index, patch] of [
      { unit: ethers.encodeBytes32String("points") },
      { minValue: 1, valueStep: 1 },
      { maxValue: 4, valueStep: 1 },
    ].entries()) {
      await expect(f.market.registerMetric({
        ...rainfallMetric, ...patch, code: ethers.encodeBytes32String(`BAD_TRACE_${index}`),
      })).to.be.revertedWithCustomError(f.market, "InvalidMetricDefinition");
    }
    expect(await f.market.metricCount()).to.equal(2n);
    await time.increaseTo(valid.config.times.openAt);
    await (await f.market.connect(f.alice).bet(valid.id, 1, { value: MIN })).wait();
    await (await f.market.connect(f.bob).bet(valid.id, 2, { value: MIN })).wait();
    await time.increaseTo(valid.config.times.earliestAssertionAt);
    await expect(f.market.checkProposal(valid.id, f.proposer, { kind: 2, value: 1 }, HASH))
      .to.be.revertedWithCustomError(f.market, "InvalidTraceValue");
    expect(await f.market.checkProposal(valid.id, f.proposer, numeric(0), HASH)).to.equal(2n);
    expect(await f.market.checkProposal(valid.id, f.proposer, trace, HASH)).to.equal(1n);
  });

  it("blocks direct writes and callbacks from untrusted accounts", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    for (const action of [
      () => f.market.connect(f.outsider).recordAssertion(m.id, f.proposer, HASH, numeric(10), HASH),
      () => f.market.connect(f.outsider).onOracleDispute(m.id, HASH),
      () => f.market.connect(f.outsider).onOracleResult(m.id, HASH, true),
    ]) {
      await expect(action()).to.be.revertedWithCustomError(f.market, "NotOracleAdapter");
    }
    await expect(f.adapter.connect(f.outsider).assertionDisputedCallback(HASH))
      .to.be.revertedWithCustomError(f.adapter, "NotOracle");
    await expect(f.adapter.connect(f.outsider).assertionResolvedCallback(HASH, true))
      .to.be.revertedWithCustomError(f.adapter, "NotOracle");
    await expect(f.adapter.settle(HASH)).to.be.revertedWithCustomError(f.adapter, "UnknownAssertion");
  });

  it("keeps betting funds separate from disputed bonds when the simulated answer accepts a NO reading", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m);
    const id = await propose(f, m, -10);
    await (await f.token.mint(f.carol, BOND)).wait();
    await (await f.token.connect(f.carol).approve(f.oracle, BOND)).wait();
    await expect(f.oracle.connect(f.carol).disputeAssertion(id, f.carol))
      .to.emit(f.market, "AssertionDisputed").withArgs(m.id, id);
    await expect(f.adapter.settle(id)).to.be.revertedWith("mock: dispute not resolved (no DVM answer)");
    await expect(f.oracle.connect(f.outsider).simulateDvmResolution(id, true)).to.be.revertedWith("mock: admin only");
    await (await f.oracle.simulateDvmResolution(id, true)).wait();
    await expect(f.adapter.settle(id)).to.emit(f.market, "MarketResolved").withArgs(m.id, 2, id, 1, -10);
    expect((await f.market.getAssertion(m.id)).disputed).to.equal(true);
    expect((await f.market.getAssertion(m.id)).rejected).to.equal(false);
    expect(await f.token.balanceOf(f.proposer)).to.equal(4n * BOND + BOND / 2n);
    expect(await f.token.balanceOf(f.carol)).to.equal(0n);
    expect(await f.token.balanceOf(f.store)).to.equal(BOND / 2n);
    expect(await f.token.balanceOf(f.oracle)).to.equal(0n);
    expect(await ethers.provider.getBalance(f.market)).to.equal(3n * MIN);
    await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-3n * MIN, 3n * MIN]);
  });

  describe("settle first at the refund boundary", function () {
    async function disputeBy(f: Fixture, assertionId: string) {
      await (await f.token.mint(f.carol, BOND)).wait();
      await (await f.token.connect(f.carol).approve(f.oracle, BOND)).wait();
      await (await f.oracle.connect(f.carol).disputeAssertion(assertionId, f.carol)).wait();
    }

    for (const [value, terminal, winner] of [[10, 1n, "alice"], [0, 2n, "bob"]] as const) {
      it(`applies a matured undisputed ${terminal === 1n ? "YES" : "NO"} result settled after refundAt`, async function () {
        const f = await networkHelpers.loadFixture(fixture);
        const m = await create(f);
        await openBoth(f, m);
        const id = await propose(f, m, value);
        await time.increaseTo(m.config.times.refundAt + 3600);
        expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([0n, 0n]);
        await expect(f.adapter.connect(f.outsider).settle(id))
          .to.emit(f.market, "MarketResolved").withArgs(m.id, terminal, id, 1, value);
        const [paid, unpaid] = winner === "alice" ? [f.alice, f.bob] : [f.bob, f.alice];
        expect(await f.market.claimable(m.id, unpaid)).to.equal(0n);
        await expect(f.market.connect(paid).claim(m.id)).to.changeEtherBalances(ethers, [f.market, paid], [-3n * MIN, 3n * MIN]);
        expect(await ethers.provider.getBalance(f.market)).to.equal(0n);
      });
    }

    it("refunds a disputed assertion at refundAt and ignores a later DVM result once the refund is active", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await openBoth(f, m);
      const id = await propose(f, m);
      await disputeBy(f, id);
      await time.increaseTo(m.config.times.refundAt);
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([3n, 3n]);
      await expect(f.market.connect(f.outsider).activateRefund(m.id))
        .to.emit(f.market, "MarketRefundActivated").withArgs(m.id, 3, f.outsider.address);
      await (await f.oracle.simulateDvmResolution(id, true)).wait();
      await expect(f.adapter.settle(id)).to.emit(f.adapter, "OracleResult").withArgs(m.id, id, 2, true);
      expect((await f.market.getMarketState(m.id)).terminal).to.equal(3n);
      const record = await f.market.getAssertion(m.id);
      expect([record.disputed, record.returned, record.rejected]).to.deep.equal([true, true, false]);
      await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-MIN, MIN]);
      await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-2n * MIN, 2n * MIN]);
    });

    it("refunds at refundAt when no assertion was made", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await openBoth(f, m);
      await time.increaseTo(m.config.times.refundAt);
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([3n, 3n]);
      await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-2n * MIN, 2n * MIN]);
    });

    it("blocks claim and activateRefund while an undisputed assertion is pending past refundAt", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await openBoth(f, m);
      const id = await propose(f, m);
      await time.increaseTo(m.config.times.refundAt + 7 * 86400);
      expect(await f.market.claimable(m.id, f.alice)).to.equal(0n);
      expect(await f.market.claimable(m.id, f.bob)).to.equal(0n);
      for (const user of [f.alice, f.bob]) {
        await expect(f.market.connect(user).claim(m.id)).to.be.revertedWithCustomError(f.market, "NothingToClaim");
      }
      await expect(f.market.activateRefund(m.id)).to.be.revertedWithCustomError(f.market, "RefundNotAvailable");
      await expect(f.adapter.settle(id)).to.emit(f.market, "MarketResolved").withArgs(m.id, 1, id, 1, 10);
      await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-3n * MIN, 3n * MIN]);
    });

    for (const second of ["refundAt - 1", "refundAt"] as const) {
      it(`accepts a matured undisputed result settled at ${second}`, async function () {
        const f = await networkHelpers.loadFixture(fixture);
        const m = await create(f);
        await openBoth(f, m);
        const id = await propose(f, m);
        const at = m.config.times.refundAt - (second === "refundAt" ? 0 : 1);
        await time.setNextBlockTimestamp(at);
        await expect(f.adapter.settle(id)).to.emit(f.adapter, "OracleResult").withArgs(m.id, id, 0, true);
        expect((await f.market.getMarketState(m.id)).terminal).to.equal(1n);
        expect(await time.latest()).to.equal(at);
      });
    }

    for (const path of ["no assertion", "a disputed assertion"] as const) {
      it(`refunds with ${path} at refundAt, not one second earlier`, async function () {
        const f = await networkHelpers.loadFixture(fixture);
        const m = await create(f);
        await openBoth(f, m);
        if (path === "a disputed assertion") await disputeBy(f, await propose(f, m));
        await time.increaseTo(m.config.times.refundAt - 1);
        expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([0n, 0n]);
        await expect(f.market.activateRefund.staticCall(m.id)).to.be.revertedWithCustomError(f.market, "RefundNotAvailable");
        await time.setNextBlockTimestamp(m.config.times.refundAt);
        await expect(f.market.connect(f.outsider).activateRefund(m.id))
          .to.emit(f.market, "MarketRefundActivated").withArgs(m.id, 3, f.outsider.address);
        await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-MIN, MIN]);
      });
    }
  });

  it("ignores unknown and replayed callbacks without changing an already finalized outcome", async function () {
    const f = await networkHelpers.loadFixture(fixture);
    const m = await create(f);
    await openBoth(f, m);
    const id = await propose(f, m);
    await (await settle(f, id)).wait();
    // Replay transport callbacks only. Impersonation is confined to the isolated test
    // network. This tests idempotence, not a production caller's ability to bypass OO.
    const oracleAddress = await f.oracle.getAddress();
    await networkHelpers.setBalance(oracleAddress, ethers.parseEther("1"));
    const oracleSigner = await ethers.getImpersonatedSigner(oracleAddress);
    try {
      await expect(f.adapter.connect(oracleSigner).assertionResolvedCallback(HASH, true))
        .to.emit(f.adapter, "UnknownAssertionIgnored").withArgs(HASH, true);
      await expect(f.adapter.connect(oracleSigner).assertionDisputedCallback(HASH))
        .to.emit(f.adapter, "UnknownAssertionIgnored").withArgs(HASH, false);
      await expect(f.adapter.connect(oracleSigner).assertionResolvedCallback(id, false))
        .to.emit(f.adapter, "OracleResult").withArgs(m.id, id, 3, false);
      await (await f.adapter.connect(oracleSigner).assertionDisputedCallback(id)).wait();
      expect((await f.market.getMarketState(m.id)).terminal).to.equal(1n);
      const assertion = await f.market.getAssertion(m.id);
      expect(assertion.returned).to.equal(true);
      expect(assertion.rejected).to.equal(false);
      expect(assertion.disputed).to.equal(false);
      expect(await f.market.claimable(m.id, f.alice)).to.equal(3n * MIN);
      expect(await ethers.provider.getBalance(f.market)).to.equal(3n * MIN);
    } finally {
      await networkHelpers.stopImpersonatingAccount(oracleAddress);
    }
  });
});
