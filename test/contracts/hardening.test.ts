import { readFileSync } from "node:fs";
import { expect } from "chai";
import { network } from "hardhat";

// Regression tests for the contract review fixes. Every connection below is an
// isolated in-process network, never the user's localhost or a public chain.
const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;
const BOND = ethers.parseUnits("10", 6);
const MIN = ethers.parseEther("0.001");
const SETTLE_WINDOW = 3600; // PredictionMarket.MIN_SETTLE_WINDOW
const SEPOLIA_SLOT = 12; // seconds between Sepolia blocks
const HASH = ethers.keccak256(ethers.toUtf8Bytes("hardening test"));
const RULES = ethers.toUtf8Bytes(JSON.stringify({ synthetic: true, protocol: "NUMERIC_OBSERVATION_V1" }));
const OUTCOME = { ACCEPTED: 0, REJECTED: 1, IGNORED_LATE: 2, IGNORED_DUPLICATE: 3 } as const;
const TERMINAL = { UNRESOLVED: 0n, YES: 1n, NO: 2n, REFUND: 3n } as const;
const NO_VALID_SETTLEMENT = 3n;
const metric = (code: string, unit: string, minValue: number, maxValue: number, valueStep: number, allowsTrace: boolean) => ({
  code: ethers.encodeBytes32String(code), unit: ethers.encodeBytes32String(unit),
  minValue, maxValue, valueStep, allowsTrace, rulesHash: HASH,
});
const POINTS = metric("POINTS_TEST", "points", -1000, 1000, 10, false); // metric 1
const RAIN = metric("RAIN_TEST", "mm", 0, 999990, 10, true); // metric 2
const numeric = (value: number) => ({ kind: 1, value });
type Condition = { metricId: number; comparison: number; lower: number; upper: number };
const GT_ZERO: Condition = { metricId: 1, comparison: 3, lower: 0, upper: 0 };

async function fixture() {
  const [admin, proposer, alice, bob, carol, outsider, store] = await ethers.getSigners();
  if (!admin || !proposer || !alice || !bob || !carol || !outsider || !store) throw new Error("This test requires seven accounts");
  const token = await ethers.deployContract("TestBondToken", ["Hardening bond", "tBOND", 6]);
  const oracle = await ethers.deployContract("MockOptimisticOracleV3", [store.address]);
  const market = await ethers.deployContract("PredictionMarket", [admin.address]);
  const adapter = await ethers.deployContract("UmaMetricOracleAdapter", [oracle, market, token, BOND]);
  await (await oracle.setCurrency(token, true, BOND)).wait();
  await (await token.mint(proposer, 4n * BOND)).wait();
  await (await token.connect(proposer).approve(adapter, 4n * BOND)).wait();
  await (await market.setOracleAdapter(adapter)).wait();
  await (await market.registerMetric(POINTS)).wait();
  await (await market.registerMetric(RAIN)).wait();
  return { admin, proposer, alice, bob, carol, outsider, store, token, oracle, market, adapter };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function configFor(f: Fixture, options: { condition?: Condition; liveness?: number; proposer?: string } = {}) {
  const now = await time.latest();
  const liveness = options.liveness ?? 60;
  const proposalCutoff = now + 1500;
  return {
    proposer: options.proposer ?? f.proposer.address,
    sourceId: ethers.encodeBytes32String("SYNTHETIC_TEST"),
    subjectId: ethers.encodeBytes32String("HARDENING"),
    condition: { ...(options.condition ?? GT_ZERO) },
    times: {
      openAt: now + 60, closeAt: now + 600, observationStart: now + 600, observationEnd: now + 900,
      earliestAssertionAt: now + 900, proposalCutoff,
      refundAt: proposalCutoff + liveness + SETTLE_WINDOW, assertionLiveness: liveness,
    },
  };
}
async function create(f: Fixture, options: Parameters<typeof configFor>[1] = {}) {
  const config = await configFor(f, options);
  await (await f.market.createMarket(config, RULES)).wait();
  return { id: await f.market.marketCount(), times: config.times };
}
type Created = Awaited<ReturnType<typeof create>>;

async function bothSides(f: Fixture, m: Created) {
  await time.increaseTo(m.times.openAt);
  await (await f.market.connect(f.alice).bet(m.id, 1, { value: MIN })).wait();
  await (await f.market.connect(f.bob).bet(m.id, 2, { value: 2n * MIN })).wait();
}
async function proposeAt(f: Fixture, id: bigint, at: number, value = 10) {
  await time.setNextBlockTimestamp(at);
  const raw = ethers.toUtf8Bytes(JSON.stringify({ synthetic: true, value100: value }));
  await (await f.adapter.connect(f.proposer).propose(id, numeric(value), {
    sourceUrl: "test:hardening", rawSha256: ethers.sha256(raw), capturedAt: at, excerpt: raw,
  }, BOND)).wait();
  return f.adapter.assertionOfMarket(id);
}
async function dispute(f: Fixture, assertionId: string) {
  await (await f.token.mint(f.carol, BOND)).wait();
  await (await f.token.connect(f.carol).approve(f.oracle, BOND)).wait();
  await (await f.oracle.connect(f.carol).disputeAssertion(assertionId, f.carol)).wait();
}

describe("Contract review fixes", function () {
  after(async function () { await connection.close(); });

  describe("F1: the designated proposer cannot bet", function () {
    it("rejects the proposer inside the betting window and lets every other account bet", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      const other = await create(f, { proposer: f.carol.address });
      await time.increaseTo(m.times.openAt - 1);
      await expect(f.market.connect(f.proposer).bet.staticCall(m.id, 1, { value: MIN }))
        .to.be.revertedWithCustomError(f.market, "BettingNotOpen");
      await time.increaseTo(m.times.openAt);
      for (const side of [1, 2]) {
        await expect(f.market.connect(f.proposer).bet(m.id, side, { value: MIN }))
          .to.be.revertedWithCustomError(f.market, "ProposerCannotBet");
      }
      await (await f.market.connect(f.alice).bet(m.id, 1, { value: MIN })).wait();
      // The restriction is per market: this proposer may bet where carol proposes.
      await (await f.market.connect(f.proposer).bet(other.id, 2, { value: MIN })).wait();
      await expect(f.market.connect(f.carol).bet(other.id, 1, { value: MIN }))
        .to.be.revertedWithCustomError(f.market, "ProposerCannotBet");
      expect((await f.market.getPosition(m.id, f.proposer)).stake).to.equal(0n);
      expect((await f.market.getPosition(other.id, f.proposer)).stake).to.equal(MIN);
      await time.increaseTo(m.times.closeAt);
      await expect(f.market.connect(f.proposer).bet.staticCall(m.id, 1, { value: MIN }))
        .to.be.revertedWithCustomError(f.market, "BettingClosed");
    });
  });

  describe("F2: liveness floor and settle window", function () {
    it("lets a 12 s slot chain settle an assertion made in the last second before the cutoff", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      // 7201 s is not a multiple of the slot time. RefundAt is the smallest allowed value.
      const m = await create(f, { liveness: 7201 });
      expect(m.times.refundAt).to.equal(m.times.proposalCutoff + 7201 + SETTLE_WINDOW);
      await bothSides(f, m);
      const slot = m.times.proposalCutoff - 1;
      const id = await proposeAt(f, m.id, slot);
      const expiry = Number((await f.oracle.getAssertion(id)).expirationTime);
      expect(m.times.refundAt - expiry).to.equal(SETTLE_WINDOW + 1);
      const nextSlot = slot + Math.ceil(7201 / SEPOLIA_SLOT) * SEPOLIA_SLOT;
      expect(nextSlot).to.be.lessThan(m.times.refundAt);
      await time.setNextBlockTimestamp(nextSlot);
      await expect(f.adapter.connect(f.outsider).settle(id))
        .to.emit(f.adapter, "OracleResult").withArgs(m.id, id, OUTCOME.ACCEPTED, true);
      expect((await f.market.getMarketState(m.id)).terminal).to.equal(TERMINAL.YES);
    });
    // The refundAt - 1 / refundAt boundary seconds are in numeric-lifecycle.test.ts
    // ("settle first at the refund boundary").
  });

  describe("F3: a rejected assertion refunds at once", function () {
    it("makes the market refundable when the oracle rejects the assertion, before refundAt", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await bothSides(f, m);
      const id = await proposeAt(f, m.id, m.times.earliestAssertionAt);
      await dispute(f, id);
      // A pending dispute alone does not refund early.
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([TERMINAL.UNRESOLVED, 0n]);
      await (await f.oracle.simulateDvmResolution(id, false)).wait();
      await expect(f.adapter.settle(id))
        .to.emit(f.adapter, "OracleResult").withArgs(m.id, id, OUTCOME.REJECTED, false);
      expect(await time.latest()).to.be.lessThan(m.times.refundAt);
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([TERMINAL.REFUND, NO_VALID_SETTLEMENT]);
      expect(await f.market.claimable(m.id, f.bob)).to.equal(2n * MIN);
      await expect(f.market.connect(f.outsider).activateRefund(m.id))
        .to.emit(f.market, "MarketRefundActivated").withArgs(m.id, NO_VALID_SETTLEMENT, f.outsider.address);
      await expect(f.market.connect(f.alice).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.alice], [-MIN, MIN]);
      await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-2n * MIN, 2n * MIN]);
      await expect(f.market.checkProposal(m.id, f.proposer, numeric(10), HASH))
        .to.be.revertedWithCustomError(f.market, "AlreadyProposed");
    });
  });

  describe("F4: a late result is recorded but ignored", function () {
    it("marks a late false result as rejected without changing the refund", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await bothSides(f, m);
      const id = await proposeAt(f, m.id, m.times.earliestAssertionAt);
      await dispute(f, id);
      await (await f.oracle.simulateDvmResolution(id, false)).wait();
      await time.increaseTo(m.times.refundAt);
      await expect(f.adapter.settle(id))
        .to.emit(f.adapter, "OracleResult").withArgs(m.id, id, OUTCOME.IGNORED_LATE, false);
      const record = await f.market.getAssertion(m.id);
      expect([record.disputed, record.returned, record.rejected]).to.deep.equal([true, true, true]);
      expect(Array.from(await f.market.getEffectiveState(m.id))).to.deep.equal([TERMINAL.REFUND, NO_VALID_SETTLEMENT]);
      await expect(f.market.connect(f.bob).claim(m.id)).to.changeEtherBalances(ethers, [f.market, f.bob], [-2n * MIN, 2n * MIN]);
    });
  });

  describe("F5: market conditions must fit the metric", function () {
    const at = (f: Fixture, condition: Condition) => configFor(f, { condition });

    it("rejects thresholds outside the metric range", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      for (const condition of [
        { ...GT_ZERO, lower: 1010 }, { ...GT_ZERO, comparison: 1, lower: -1010 },
        { ...GT_ZERO, comparison: 5, lower: 0, upper: 1010 }, { ...GT_ZERO, comparison: 5, lower: -1010, upper: 0 },
      ]) {
        await expect(f.market.createMarket(await at(f, condition), RULES))
          .to.be.revertedWithCustomError(f.market, "ThresholdOutOfRange");
      }
      expect(await f.market.marketCount()).to.equal(0n);
    });

    it("rejects thresholds that are not multiples of the metric step", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      for (const condition of [
        { ...GT_ZERO, lower: 5 }, { ...GT_ZERO, comparison: 2, lower: -15 },
        { ...GT_ZERO, comparison: 5, lower: 0, upper: 15 }, { ...GT_ZERO, comparison: 5, lower: -5, upper: 10 },
      ]) {
        await expect(f.market.createMarket(await at(f, condition), RULES))
          .to.be.revertedWithCustomError(f.market, "ThresholdStepMismatch");
      }
      for (const condition of [
        { ...GT_ZERO, lower: 1000 }, { ...GT_ZERO, comparison: 1, lower: -1000 },
        { ...GT_ZERO, comparison: 5, lower: -1000, upper: 1000 }, { ...GT_ZERO, comparison: 4, lower: -20 },
      ]) {
        await (await f.market.createMarket(await at(f, condition), RULES)).wait();
      }
      expect(await f.market.marketCount()).to.equal(4n);
    });

    it("rejects conditions Trace cannot decide, only on trace-enabled metrics", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      await (await f.market.registerMetric(metric("RAIN_FINE", "mm", 0, 100000, 1, true))).wait(); // metric 3
      await (await f.market.registerMetric(metric("POINTS_FINE", "points", 0, 100000, 1, false))).wait(); // metric 4
      const undecidable = [
        { metricId: 3, comparison: 3, lower: 2, upper: 0 }, { metricId: 3, comparison: 2, lower: 4, upper: 0 },
        { metricId: 3, comparison: 5, lower: 0, upper: 4 }, { metricId: 3, comparison: 5, lower: 1, upper: 5 },
      ];
      for (const condition of undecidable) {
        await expect(f.market.createMarket(await at(f, condition), RULES))
          .to.be.revertedWithCustomError(f.market, "IndeterminateTraceCondition");
        await (await f.market.createMarket(await at(f, { ...condition, metricId: 4 }), RULES)).wait();
      }
      for (const condition of [
        { metricId: 3, comparison: 3, lower: 0, upper: 0 }, { metricId: 3, comparison: 4, lower: 5, upper: 0 },
        { metricId: 3, comparison: 5, lower: 0, upper: 5 }, { metricId: 3, comparison: 5, lower: 5, upper: 10 },
        { metricId: 2, comparison: 4, lower: 100, upper: 0 },
      ]) {
        await (await f.market.createMarket(await at(f, condition), RULES)).wait();
      }
      expect(await f.market.marketCount()).to.equal(9n);
    });
  });

  describe("F6: trace-enabled metrics must cover the Trace interval", function () {
    it("refuses Trace on other units or ranges that miss (0, 0.05 mm) and accepts the exact edges", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      for (const bad of [
        metric("TRACE_DEGC", "degC", 0, 100000, 1, true),
        metric("TRACE_MIN_1", "mm", 1, 100000, 1, true),
        metric("TRACE_MAX_4", "mm", 0, 4, 1, true),
      ]) {
        await expect(f.market.registerMetric(bad)).to.be.revertedWithCustomError(f.market, "InvalidMetricDefinition");
      }
      await (await f.market.registerMetric(metric("TRACE_EDGES", "mm", 0, 5, 1, true))).wait();
      await (await f.market.registerMetric(metric("NO_TRACE_SMALL", "points", 1, 4, 1, false))).wait();
      expect(await f.market.metricCount()).to.equal(4n);
    });
  });

  describe("F7: adapter construction", function () {
    it("requires a nonzero policy bond", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      await expect(ethers.deployContract("UmaMetricOracleAdapter", [f.oracle, f.market, f.token, 0]))
        .to.be.revertedWithCustomError(f.adapter, "ZeroPolicyBond");
    });

    it("pins the canonical OOV3 and the 6TEST bond token on chain 11155111", async function () {
      // A separate in-process network with Sepolia's chain id, not a fork. setCode places
      // local test doubles at the pinned addresses. This checks the constructor only.
      const uma = JSON.parse(readFileSync("config/uma-sepolia.json", "utf8")) as {
        optimisticOracleV3: string; selectedBondCurrency: string;
      };
      const canonical = ethers.getAddress(uma.optimisticOracleV3);
      const pinned = ethers.getAddress(uma.selectedBondCurrency);
      const sepolia = await network.create({ override: { chainId: 11155111 } });
      try {
        const e = sepolia.ethers;
        const [admin, store] = await e.getSigners();
        if (!admin || !store) throw new Error("This test requires two accounts");
        expect((await e.provider.getNetwork()).chainId).to.equal(11155111n);
        const market = await e.deployContract("PredictionMarket", [admin.address]);
        const oracle = await e.deployContract("MockOptimisticOracleV3", [store.address]);
        const token = await e.deployContract("TestBondToken", ["Six", "6TEST", 6]);
        const factory = await e.getContractFactory("UmaMetricOracleAdapter");
        await sepolia.networkHelpers.setCode(canonical, await e.provider.getCode(oracle));
        await sepolia.networkHelpers.setCode(pinned, await e.provider.getCode(token));
        await expect(e.deployContract("UmaMetricOracleAdapter", [oracle, market, pinned, BOND]))
          .to.be.revertedWithCustomError(factory, "NotCanonicalOracle").withArgs(await oracle.getAddress());
        await expect(e.deployContract("UmaMetricOracleAdapter", [canonical, market, token, BOND]))
          .to.be.revertedWithCustomError(factory, "NotPinnedBondCurrency").withArgs(await token.getAddress());
        await expect(e.deployContract("UmaMetricOracleAdapter", [canonical, market, pinned, 0]))
          .to.be.revertedWithCustomError(factory, "ZeroPolicyBond");
        const adapter = await e.deployContract("UmaMetricOracleAdapter", [canonical, market, pinned, BOND]);
        expect([
          await adapter.oov3(), await adapter.CANONICAL_SEPOLIA_OOV3(),
          await adapter.bondCurrency(), await adapter.SEPOLIA_BOND_CURRENCY(),
        ]).to.deep.equal([canonical, canonical, pinned, pinned]);
      } finally {
        await sepolia.close();
      }
    });
  });

  describe("review scenarios kept as regressions", function () {
    it("does not pay a reentrant claim twice, and a reentrant settle leaves no damage", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const attacker = await ethers.deployContract("ReentrantClaimer", [f.market, f.adapter]);
      const m = await create(f);
      const other = await create(f);
      await time.increaseTo(m.times.openAt);
      await (await attacker.placeBet(m.id, 1, { value: MIN })).wait();
      await (await f.market.connect(f.bob).bet(m.id, 2, { value: MIN })).wait();
      await (await f.market.connect(f.alice).bet(other.id, 1, { value: MIN })).wait();
      await (await f.market.connect(f.bob).bet(other.id, 2, { value: MIN })).wait();
      const id = await proposeAt(f, m.id, other.times.earliestAssertionAt);
      const otherId = await proposeAt(f, other.id, other.times.earliestAssertionAt + 1);
      await time.increaseTo((await f.oracle.getAssertion(otherId)).expirationTime);
      await (await f.adapter.settle(id)).wait(); // market m resolves YES; the attacker is owed 2 * MIN
      const MODE = { NONE: 0, CLAIM_AGAIN: 1, SETTLE_OTHER: 2, CLAIM_AGAIN_CAUGHT: 3 };
      await expect(attacker.attack(MODE.CLAIM_AGAIN, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.market, "TransferFailed");
      await expect(attacker.attack(MODE.SETTLE_OTHER, otherId))
        .to.be.revertedWithCustomError(f.market, "TransferFailed");
      expect((await f.oracle.getAssertion(otherId)).settled).to.equal(false);
      await expect(attacker.attack(MODE.CLAIM_AGAIN_CAUGHT, ethers.ZeroHash))
        .to.changeEtherBalances(ethers, [f.market, attacker], [-2n * MIN, 2n * MIN]);
      expect(await attacker.reentryFailed()).to.equal(true);
      await expect(attacker.attack(MODE.NONE, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.market, "NothingToClaim");
      await expect(f.adapter.settle(otherId)).to.emit(f.market, "MarketResolved");
    });

    it("ignores a real third-party assertion that names the adapter as callback recipient", async function () {
      const f = await networkHelpers.loadFixture(fixture);
      const m = await create(f);
      await bothSides(f, m);
      await (await f.token.mint(f.outsider, BOND)).wait();
      await (await f.token.connect(f.outsider).approve(f.oracle, BOND)).wait();
      const receipt = await (await f.oracle.connect(f.outsider).assertTruth(
        ethers.toUtf8Bytes(`decoy for market ${m.id}`), f.outsider.address, f.adapter, ethers.ZeroAddress,
        60, f.token, BOND, ethers.encodeBytes32String("ASSERT_TRUTH"), ethers.ZeroHash,
      )).wait();
      const made = receipt!.logs
        .map((log) => { try { return f.oracle.interface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed?.name === "AssertionMade");
      const decoy = made!.args.assertionId as string;
      await time.increase(61);
      await expect(f.oracle.settleAssertion(decoy))
        .to.emit(f.adapter, "UnknownAssertionIgnored").withArgs(decoy, true);
      expect((await f.market.getMarketState(m.id)).terminal).to.equal(TERMINAL.UNRESOLVED);
      expect(await f.adapter.marketOfAssertion(decoy)).to.equal(0n);
      await expect(f.adapter.settle(decoy)).to.be.revertedWithCustomError(f.adapter, "UnknownAssertion");
    });
  });
});
