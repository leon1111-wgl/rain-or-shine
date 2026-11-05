import { expect } from "chai";
import { network } from "hardhat";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;

const SIDE = { YES: 1, NO: 2 } as const;
const BOND = ethers.parseUnits("10", 6);
const YES_STAKE = ethers.parseEther("0.01");
const NO_STAKE = ethers.parseEther("0.02");
const EVIDENCE_SOURCE_URL =
    "onchain:UmaMetricOracleAdapter.EvidencePublished.excerpt";
const RESULT_SCHEMA = "RAINPOOL_TEST_NUMERIC_RESULT_V1";

type ObservationWindow = {
    observationStart: number;
    observationEnd: number;
};

async function temperatureEvidence(
    window: ObservationWindow,
    publisher: string,
    value100: number
) {
    const capturedAt = await time.latest();
    if (capturedAt < window.observationEnd) {
        throw new Error("Create a synthetic result only after observationEnd");
    }
    const rawBytes = ethers.toUtf8Bytes(JSON.stringify({
        schema: RESULT_SCHEMA,
        synthetic: true,
        status: "FINAL",
        publisher,
        sourceId: "DEMO_TEMPERATURE",
        subjectId: "DEMO_STATION",
        metric: "DAILY_MAX_TEMPERATURE",
        unit: "degC",
        scale: 100,
        observationStart: window.observationStart,
        observationEnd: window.observationEnd,
        value100
    }));
    return {
        sourceUrl: EVIDENCE_SOURCE_URL,
        capturedAt,
        rawSha256: ethers.sha256(rawBytes),
        excerpt: rawBytes
    };
}

async function pressureRecord(
    window: ObservationWindow,
    publisher: string,
    pressures: { startHpa: number; endHpa: number }
) {
    const capturedAt = await time.latest();
    if (capturedAt < window.observationEnd) {
        throw new Error("Create a synthetic result only after observationEnd");
    }
    const rawBytes = ethers.toUtf8Bytes(JSON.stringify({
        schema: RESULT_SCHEMA,
        synthetic: true,
        status: "FINAL",
        publisher,
        sourceId: "DEMO_PRESSURE",
        subjectId: "HKO_PRESSURE",
        metric: "PRESSURE_CHANGE",
        unit: "hPa",
        scale: 100,
        observationStart: window.observationStart,
        observationEnd: window.observationEnd,
        startHpa: pressures.startHpa,
        endHpa: pressures.endHpa
    }));
    return {
        reading: { kind: 1, value: (pressures.endHpa - pressures.startHpa) * 100 },
        evidence: {
            sourceUrl: EVIDENCE_SOURCE_URL,
            capturedAt,
            rawSha256: ethers.sha256(rawBytes),
            excerpt: rawBytes
        }
    };
}

function expectQuestionOnlyRules(rulesDocument: Uint8Array) {
    const rules = JSON.parse(ethers.toUtf8String(rulesDocument));
    expect(rules).to.include({
        protocol: "NUMERIC_OBSERVATION_V1",
        synthetic: true
    });
    for (const field of [
        "value100", "startHpa", "endHpa", "expectedFixtureSha256",
        "rawSha256", "fixture", "result"
    ]) {
        expect(rules, "creation rule must not contain " + field)
            .not.to.have.property(field);
    }
}

async function temperatureFixture() {
    const [admin, proposer, yesUser, noUser, settler, store] =
        await ethers.getSigners();

    if (!admin || !proposer || !yesUser || !noUser || !settler || !store) {
        throw new Error("This test requires six local accounts");
    }

    const token = await ethers.deployContract(
        "TestBondToken", ["Test bond", "tBOND", 6]
    );
    const oracle = await ethers.deployContract(
        "MockOptimisticOracleV3", [store.address]
    );
    const market = await ethers.deployContract(
        "PredictionMarket", [admin.address], admin
    );
    const adapter = await ethers.deployContract(
        "UmaMetricOracleAdapter", [oracle, market, token, BOND]
    );

    await (await market.connect(admin).setOracleAdapter(adapter)).wait();
    await (await oracle.setCurrency(token, true, BOND)).wait();
    await (await token.mint(proposer.address, BOND)).wait();
    await (await token.connect(proposer).approve(adapter, BOND)).wait();

    const metricRules = JSON.stringify({
        version: 2,
        metric: "DAILY_MAX_TEMPERATURE",
        unit: "degC",
        scale: 100,
        interpretation:
            "A FINAL observation record reports maximum temperature " +
            "over [observationStart, observationEnd). Require matching sourceId, " +
            "subjectId, metric, unit, scale and interval. Read the signed integer " +
            "value100 as NUMERIC. Missing or mismatched fields are invalid. " +
            "The registered range is -50 to 60 degC, in steps of 0.1 degC; " +
            "TRACE is not accepted."
    });
    const metricRulesHash = ethers.keccak256(ethers.toUtf8Bytes(metricRules));

    const code = ethers.encodeBytes32String("DAILY_MAX_TEMPERATURE");

    await (await market.connect(admin).registerMetric({
        code,
        unit: ethers.encodeBytes32String("degC"),
        minValue: -5000,
        maxValue: 6000,
        valueStep: 10,
        allowsTrace: false,
        rulesHash: metricRulesHash
    })).wait();

    const metricId = await market.metricIdByCode(code);

    const now = await time.latest();
    const observationStart = now + 180;
    const observationEnd = observationStart + 86400;

    const times = {
        openAt: now + 60,
        closeAt: now + 120,
        observationStart,
        observationEnd,
        earliestAssertionAt: observationEnd + 60,
        proposalCutoff: observationEnd + 660,
        refundAt: observationEnd + 660 + 60 + 3600,
        assertionLiveness: 60
    };

    const rulesDocument = ethers.toUtf8Bytes(JSON.stringify({
        schema: "RAINPOOL_TEST_MARKET_RULES_V2",
        protocol: "NUMERIC_OBSERVATION_V1",
        synthetic: true,
        sourceId: "DEMO_TEMPERATURE",
        subjectId: "DEMO_STATION",
        observationStart,
        observationEnd,
        metricId: metricId.toString(),
        metric: "DAILY_MAX_TEMPERATURE",
        unit: "degC",
        scale: 100,
        metricRulesHash,
        metricRulesDocument: metricRules,
        authorizedSyntheticProcedure: {
            publisher: proposer.address,
            resultSchema: RESULT_SCHEMA,
            publication: EVIDENCE_SOURCE_URL,
            procedure:
                "After observationEnd, the configured proposer chooses a synthetic " +
                "maximum temperature within the registered range and step and " +
                "publishes one FINAL record with matching identity and interval. " +
                "The complete record is published in EvidencePublished for this " +
                "market and assertion. Its signed value100 is the demonstration result."
        },
        finalityPolicy: "Require FINAL and capture at or after observationEnd.",
        missingDataPolicy: "No valid observation means no valid assertion; refund at refundAt.",
        revisionPolicy: "A market permits one assertion; a rejected assertion cannot be replaced and refunds the market.",
        interpretation:
            "Synthetic demonstration only, not a claim about real weather. " +
            "The result and its evidence hash are supplied after observationEnd; " +
            "neither is fixed at market creation. Apply the onchain threshold " +
            "only after the submitted reading is accepted by the oracle."
    }));
    expectQuestionOnlyRules(rulesDocument);

    await (await market.connect(admin).createMarket({
        proposer: proposer.address,
        sourceId: ethers.encodeBytes32String("DEMO_TEMPERATURE"),
        subjectId: ethers.encodeBytes32String("DEMO_STATION"),
        condition: {
            metricId,
            comparison: 3,
            lower: 3200,
            upper: 0
        },
        times
    }, rulesDocument)).wait();

    const marketId = await market.marketCount();

    return {
        market, adapter, oracle, token, proposer,
        yesUser, noUser, settler, times, marketId,
        rulesDocument
    };
}

describe("Generic metric market: temperature lifecycle", function () {
    after(async function () {
        await connection.close();
    });

    it("settles 33.2 > 32 as YES and pays the winner exactly once", async function () {
        const f = await networkHelpers.loadFixture(temperatureFixture);
        const total = YES_STAKE + NO_STAKE;

        expect(await f.market.marketRulesHash(f.marketId)).to.equal(
            ethers.keccak256(f.rulesDocument)
        );

        await time.increaseTo(f.times.openAt);

        await (await f.market.connect(f.yesUser).bet(
            f.marketId, SIDE.YES, { value: YES_STAKE }
        )).wait();

        await (await f.market.connect(f.noUser).bet(
            f.marketId, SIDE.NO, { value: NO_STAKE }
        )).wait();

        await time.increaseTo(f.times.earliestAssertionAt);

        const evidence = await temperatureEvidence(
            f.times, f.proposer.address, 3320
        );

        await (await f.adapter.connect(f.proposer).propose(
            f.marketId, { kind: 1, value: 3320 }, evidence, BOND
        )).wait();

        const id = await f.adapter.assertionOfMarket(f.marketId);

        expect(id).not.to.equal(ethers.ZeroHash);
        expect(await f.adapter.marketOfAssertion(id)).to.equal(f.marketId);
        expect(await f.market.marketOfAssertion(id)).to.equal(f.marketId);
        expect((await f.market.getAssertion(f.marketId)).assertionId).to.equal(id);

        expect(await f.token.balanceOf(f.proposer)).to.equal(0n);
        expect(await f.token.balanceOf(f.oracle)).to.equal(BOND);
        expect(await f.token.balanceOf(f.adapter)).to.equal(0n);
        expect(await ethers.provider.getBalance(f.market)).to.equal(total);

        const assertion = await f.oracle.getAssertion(id);
        await time.increaseTo(assertion.expirationTime);

        await expect(f.adapter.connect(f.settler).settle(id))
            .to.emit(f.adapter, "OracleResult")
            .withArgs(f.marketId, id, 0n, true);

        expect((await f.market.getMarketState(f.marketId)).terminal).to.equal(1n);
        expect(await f.token.balanceOf(f.proposer)).to.equal(BOND);
        expect(await ethers.provider.getBalance(f.market)).to.equal(total);

        expect(await f.market.claimable(f.marketId, f.yesUser)).to.equal(total);
        expect(await f.market.claimable(f.marketId, f.noUser)).to.equal(0n);

        await expect(f.market.connect(f.yesUser).claim(f.marketId))
            .to.changeEtherBalance(ethers, f.yesUser, total);

        expect(await ethers.provider.getBalance(f.market)).to.equal(0n);

        await expect(f.market.connect(f.yesUser).claim(f.marketId))
            .to.be.revertedWithCustomError(f.market, "NothingToClaim");

        await expect(f.market.connect(f.noUser).claim(f.marketId))
            .to.be.revertedWithCustomError(f.market, "NothingToClaim");
    });

    it("refunds both stakes as soon as a simulated disputed rejection returns", async function () {
        const f = await networkHelpers.loadFixture(temperatureFixture);
        const disputer = f.settler;
        const total = YES_STAKE + NO_STAKE;

        await time.increaseTo(f.times.openAt);

        await (await f.market.connect(f.yesUser).bet(
            f.marketId, SIDE.YES, { value: YES_STAKE }
        )).wait();

        await (await f.market.connect(f.noUser).bet(
            f.marketId, SIDE.NO, { value: NO_STAKE }
        )).wait();

        await time.increaseTo(f.times.earliestAssertionAt);

        const evidence = await temperatureEvidence(
            f.times, f.proposer.address, 3320
        );

        await (await f.adapter.connect(f.proposer).propose(
            f.marketId, { kind: 1, value: 3000 }, evidence, BOND
        )).wait();

        const id = await f.adapter.assertionOfMarket(f.marketId);

        await (await f.token.mint(disputer.address, BOND)).wait();
        await (await f.token.connect(disputer).approve(f.oracle, BOND)).wait();

        await expect(
            f.oracle.connect(disputer).disputeAssertion(id, disputer.address)
        ).to.emit(f.adapter, "DisputeCallbackReceived")
            .withArgs(f.marketId, id);

        expect((await f.market.getAssertion(f.marketId)).disputed).to.equal(true);

        await expect(f.adapter.connect(f.yesUser).settle(id))
            .to.be.revertedWith("mock: dispute not resolved (no DVM answer)");

        await (await f.oracle.simulateDvmResolution(id, false)).wait();

        await expect(f.adapter.connect(f.yesUser).settle(id))
            .to.emit(f.adapter, "OracleResult")
            .withArgs(f.marketId, id, 1n, false);

        const record = await f.market.getAssertion(f.marketId);
        expect(record.returned).to.equal(true);
        expect(record.rejected).to.equal(true);

        expect(await time.latest()).to.be.lessThan(f.times.refundAt);
        expect(await f.market.getEffectiveState(f.marketId))
            .to.deep.equal([3n, 3n]);

        expect(await f.market.claimable(f.marketId, f.yesUser)).to.equal(YES_STAKE);
        expect(await f.market.claimable(f.marketId, f.noUser)).to.equal(NO_STAKE);
        expect(await ethers.provider.getBalance(f.market)).to.equal(total);

        await expect(f.adapter.connect(f.proposer).propose(
            f.marketId, { kind: 1, value: 3320 }, evidence, BOND
        )).to.be.revertedWithCustomError(f.market, "AlreadyProposed");

        const fee = BOND / 2n;

        expect(await f.token.balanceOf(f.proposer)).to.equal(0n);
        expect(await f.token.balanceOf(disputer)).to.equal(2n * BOND - fee);
        expect(await f.token.balanceOf(await f.oracle.store())).to.equal(fee);
        expect(await f.token.balanceOf(f.oracle)).to.equal(0n);

        const firstClaim = f.market.connect(f.yesUser).claim(f.marketId);
        await expect(firstClaim).to.changeEtherBalance(ethers, f.yesUser, YES_STAKE);
        await expect(firstClaim).to.emit(f.market, "MarketRefundActivated")
            .withArgs(f.marketId, 3n, f.yesUser.address);

        await expect(f.market.connect(f.noUser).claim(f.marketId))
            .to.changeEtherBalance(ethers, f.noUser, NO_STAKE);
        expect(await time.latest()).to.be.lessThan(f.times.refundAt);

        const state = await f.market.getMarketState(f.marketId);
        expect(state.terminal).to.equal(3n);
        expect(state.paidOut).to.equal(total);
        expect(await ethers.provider.getBalance(f.market)).to.equal(0n);

        await expect(f.market.connect(f.yesUser).claim(f.marketId))
            .to.be.revertedWithCustomError(f.market, "NothingToClaim");
    });

    it("adds PRESSURE_CHANGE without redeployment and isolates two markets", async function () {
        const f = await networkHelpers.loadFixture(temperatureFixture);

        const marketAddress = await f.market.getAddress();
        const adapterAddress = await f.adapter.getAddress();
        const marketCode = await ethers.provider.getCode(marketAddress);
        const adapterCode = await ethers.provider.getCode(adapterAddress);

        const oldConfig = await f.market.getMarketConfig(f.marketId);
        const oldMetric = await f.market.getMetric(oldConfig.condition.metricId);
        const oldRulesHash = await f.market.marketRulesHash(f.marketId);
        const oldMetricCount = await f.market.metricCount();
        const oldMarketCount = await f.market.marketCount();

        const pressureCode = ethers.encodeBytes32String("PRESSURE_CHANGE");
        expect(await f.market.metricIdByCode(pressureCode)).to.equal(0n);

        const metricRules = JSON.stringify({
            version: 2, metric: "PRESSURE_CHANGE", unit: "hPa", scale: 100,
            interpretation:
                "Use an observation record with status FINAL. " +
                "startHpa and endHpa are whole-hPa sea-level pressures at the start and end of the window. " +
                "Require matching sourceId, subjectId, metric, unit, scale and observation interval. " +
                "Derive the NUMERIC reading as (endHpa - startHpa) * 100. " +
                "Missing, conflicting or non-final data is invalid. " +
                "The registered range is -500 to 500 hPa, in steps of 1 hPa. " +
                "TRACE is not accepted."
        });

        const definition = {
            code: pressureCode,
            unit: ethers.encodeBytes32String("hPa"),
            minValue: -50000,
            maxValue: 50000,
            valueStep: 100,
            allowsTrace: false,
            rulesHash: ethers.keccak256(ethers.toUtf8Bytes(metricRules))
        };

        await expect(f.market.connect(f.settler).registerMetric(definition))
            .to.be.revertedWithCustomError(f.market, "OnlyMetricAdmin");

        await (await f.market.registerMetric(definition)).wait();

        const pressureMetricId = await f.market.metricIdByCode(pressureCode);
        expect(pressureMetricId).not.to.equal(oldConfig.condition.metricId);
        expect(await f.market.metricCount()).to.equal(oldMetricCount + 1n);

        const pressureRules = ethers.toUtf8Bytes(JSON.stringify({
            schema: "RAINPOOL_TEST_MARKET_RULES_V2",
            protocol: "NUMERIC_OBSERVATION_V1",
            synthetic: true,
            sourceId: "DEMO_PRESSURE",
            subjectId: "HKO_PRESSURE",
            observationStart: f.times.observationStart,
            observationEnd: f.times.observationEnd,
            station: "HKO",
            metricId: pressureMetricId.toString(),
            metric: "PRESSURE_CHANGE",
            unit: "hPa",
            scale: 100,
            metricRulesHash: definition.rulesHash,
            metricRulesDocument: metricRules,
            authorizedSyntheticProcedure: {
                publisher: f.proposer.address,
                resultSchema: RESULT_SCHEMA,
                publication: EVIDENCE_SOURCE_URL,
                procedure:
                    "After observationEnd, the configured proposer reads the whole-hPa " +
                    "pressures at the start and end of the window. Publish one FINAL " +
                    "record with the fixed identity and interval. The complete record is " +
                    "published in EvidencePublished for this market and assertion. " +
                    "The change must satisfy the registered range and step."
            },
            finalityPolicy: "Require FINAL and capture at or after observationEnd.",
            missingDataPolicy: "No valid observation means no valid assertion; refund at refundAt.",
            revisionPolicy: "A market permits one assertion; a rejected assertion cannot be replaced and refunds the market.",
            interpretation:
                "Synthetic test data, not a real pressure reading. " +
                "The result and its evidence hash are supplied after observationEnd. " +
                "Neither is fixed at market creation. " +
                "A submitted result cannot change the station or the window."
        }));
        expectQuestionOnlyRules(pressureRules);

        await (await f.market.createMarket({
            proposer: f.proposer.address,
            sourceId: ethers.encodeBytes32String("DEMO_PRESSURE"),
            subjectId: ethers.encodeBytes32String("HKO_PRESSURE"),
            condition: {
                metricId: pressureMetricId,
                comparison: 3,
                lower: 0,
                upper: 0
            },
            times: f.times
        }, pressureRules)).wait();

        const pressureMarketId = await f.market.marketCount();
        expect(pressureMarketId).to.equal(oldMarketCount + 1n);

        expect(await f.market.getMarketConfig(f.marketId)).to.deep.equal(oldConfig);
        expect(await f.market.getMetric(oldConfig.condition.metricId)).to.deep.equal(oldMetric);
        expect(await f.market.marketRulesHash(f.marketId)).to.equal(oldRulesHash);

        await (await f.token.mint(f.proposer.address, BOND)).wait();
        await (await f.token.connect(f.proposer).approve(f.adapter, 2n * BOND)).wait();

        const pressureYesStake = ethers.parseEther("0.04");
        const pressureNoStake = ethers.parseEther("0.05");
        const temperatureTotal = YES_STAKE + NO_STAKE;
        const pressureTotal = pressureYesStake + pressureNoStake;

        await time.increaseTo(f.times.openAt);

        await (await f.market.connect(f.yesUser).bet(
            f.marketId, SIDE.YES, { value: YES_STAKE }
        )).wait();

        await (await f.market.connect(f.noUser).bet(
            f.marketId, SIDE.NO, { value: NO_STAKE }
        )).wait();

        await (await f.market.connect(f.noUser).bet(
            pressureMarketId, SIDE.YES, { value: pressureYesStake }
        )).wait();

        await (await f.market.connect(f.yesUser).bet(
            pressureMarketId, SIDE.NO, { value: pressureNoStake }
        )).wait();

        expect(await ethers.provider.getBalance(f.market))
            .to.equal(temperatureTotal + pressureTotal);

        await time.increaseTo(f.times.earliestAssertionAt);

        const temperatureResult = await temperatureEvidence(
            f.times, f.proposer.address, 3320
        );
        const pressureResult = await pressureRecord(
            f.times, f.proposer.address,
            { startHpa: 1012, endHpa: 1007 }
        );
        const pressureEvidence = pressureResult.evidence;

        await expect(f.adapter.connect(f.proposer).propose(
            pressureMarketId, { kind: 1, value: -550 }, pressureEvidence, BOND
        )).to.be.revertedWithCustomError(f.market, "ReadingStepMismatch");

        await (await f.adapter.connect(f.proposer).propose(
            f.marketId,
            { kind: 1, value: 3320 },
            temperatureResult,
            BOND
        )).wait();

        await (await f.adapter.connect(f.proposer).propose(
            pressureMarketId, pressureResult.reading, pressureEvidence, BOND
        )).wait();

        const tempId = await f.adapter.assertionOfMarket(f.marketId);
        const pressureId = await f.adapter.assertionOfMarket(pressureMarketId);

        expect(pressureId).not.to.equal(tempId);

        for (const [id, marketId] of [
            [tempId, f.marketId],
            [pressureId, pressureMarketId]
        ] as const) {
            expect(await f.adapter.marketOfAssertion(id)).to.equal(marketId);
            expect(await f.market.marketOfAssertion(id)).to.equal(marketId);
        }

        expect((await f.market.getAssertion(pressureMarketId)).reading.value)
            .to.equal(-500n);

        const assertion = await f.oracle.getAssertion(pressureId);
        await time.increaseTo(assertion.expirationTime);

        await expect(f.adapter.connect(f.settler).settle(pressureId))
            .to.emit(f.adapter, "OracleResult")
            .withArgs(pressureMarketId, pressureId, 0n, true);

        expect((await f.market.getMarketState(pressureMarketId)).terminal).to.equal(2n);
        expect((await f.market.getMarketState(f.marketId)).terminal).to.equal(0n);
        expect((await f.market.getAssertion(f.marketId)).returned).to.equal(false);

        await expect(f.market.connect(f.yesUser).claim(pressureMarketId))
            .to.changeEtherBalance(ethers, f.yesUser, pressureTotal);

        expect(await ethers.provider.getBalance(f.market)).to.equal(temperatureTotal);

        await (await f.adapter.connect(f.settler).settle(tempId)).wait();

        expect((await f.market.getMarketState(f.marketId)).terminal).to.equal(1n);

        await expect(f.market.connect(f.yesUser).claim(f.marketId))
            .to.changeEtherBalance(ethers, f.yesUser, temperatureTotal);

        expect(await ethers.provider.getBalance(f.market)).to.equal(0n);
        expect(await f.token.balanceOf(f.proposer)).to.equal(2n * BOND);

        expect(await f.market.getAddress()).to.equal(marketAddress);
        expect(await f.adapter.getAddress()).to.equal(adapterAddress);
        expect(await ethers.provider.getCode(marketAddress)).to.equal(marketCode);
        expect(await ethers.provider.getCode(adapterAddress)).to.equal(adapterCode);
    });
});
