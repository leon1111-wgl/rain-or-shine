import { expect } from "chai";
import { network } from "hardhat";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { time } = networkHelpers;

const BOND = ethers.parseUnits("10", 6);
const STAKE = ethers.parseEther("0.01");
const SOURCE_URL = "test-fixture:synthetic-numeric-observations";

interface Evidence {
    sourceUrl: string;
    rawSha256: string;
    capturedAt: number;
    excerpt: string;
}

// 这里只部署到 Hardhat 的独立测试网络，不连接运行中的 localhost 节点。
async function marketFixture() {
    const [admin, proposer, yesUser, noUser, outsider, store] =
        await ethers.getSigners();
    if (!admin || !proposer || !yesUser || !noUser || !outsider || !store) {
        throw new Error("This test requires six accounts");
    }

    const token = await ethers.deployContract(
        "TestBondToken", ["Test bond", "tBOND", 6]
    );
    const oracle = await ethers.deployContract(
        "MockOptimisticOracleV3", [store.address]
    );
    const market = await ethers.deployContract("PredictionMarket", [admin.address]);
    const adapter = await ethers.deployContract(
        "UmaMetricOracleAdapter", [oracle, market, token, BOND]
    );

    await (await market.setOracleAdapter(adapter)).wait();
    await (await oracle.setCurrency(token, true, BOND)).wait();
    await (await token.mint(proposer.address, BOND)).wait();
    await (await token.connect(proposer).approve(adapter, BOND)).wait();

    // 测试自包含规则，不依赖尚未迁移的链下 parser，也不声称是真实 HKO 数据。
    const metricRules = JSON.stringify({
        schema: "TEST_NUMERIC_METRIC_V1",
        code: "DAILY_MAX_TEMPERATURE",
        unit: "degC",
        scale: 100,
        interpretation:
            "Read value100 from the unique FINAL observation matching sourceId, " +
            "subjectId and [observationStart, observationEnd). Require metric " +
            "DAILY_MAX_TEMPERATURE, unit degC, scale 100 and synthetic=true. " +
            "The reading is NUMERIC with a step of 10. Trace is invalid."
    });
    const metricRulesHash = ethers.keccak256(ethers.toUtf8Bytes(metricRules));

    await (await market.registerMetric({
        code: ethers.encodeBytes32String("DAILY_MAX_TEMPERATURE"),
        unit: ethers.encodeBytes32String("degC"),
        minValue: -5000,
        maxValue: 6000,
        valueStep: 10,
        allowsTrace: false,
        rulesHash: metricRulesHash
    })).wait();
    const metricId = await market.metricCount();

    const now = await time.latest();
    const times = {
        openAt: now + 60,
        closeAt: now + 120,
        observationStart: now + 180,
        observationEnd: now + 480,
        earliestAssertionAt: now + 540,
        proposalCutoff: now + 1140,
        // 截止 + 挑战期之后至少 1 小时结算窗口。
        refundAt: now + 1140 + 60 + 3600,
        assertionLiveness: 60
    };

    const rulesDocument = ethers.toUtf8Bytes(JSON.stringify({
        schema: "TEST_NUMERIC_MARKET_V1",
        synthetic: true,
        sourceId: "DEMO_TEMPERATURE",
        subjectId: "DEMO_STATION",
        sourceUrl: SOURCE_URL,
        observationStart: times.observationStart,
        observationEnd: times.observationEnd,
        metricRulesDocument: metricRules,
        metricRulesHash,
        demonstrationProcedure:
            "After the observation window the test operator may choose a " +
            "synthetic value and publish a source document containing an " +
            "observations array. The result is not independently determined.",
        finalityPolicy: "Require status FINAL and exactly one matching record.",
        missingDataPolicy: "Missing, malformed or ambiguous data invalidates the assertion.",
        revisionPolicy: "Use the snapshot identified by the assertion; finalized outcomes do not change."
    }));
    const config = {
        proposer: proposer.address,
        sourceId: ethers.encodeBytes32String("DEMO_TEMPERATURE"),
        subjectId: ethers.encodeBytes32String("DEMO_STATION"),
        condition: { metricId, comparison: 3, lower: 3200, upper: 0 },
        times
    };
    const creation = await market.createMarket(config, rulesDocument);
    await creation.wait();
    const marketId = await market.marketCount();
    await expect(creation).to.emit(market, "MarketCreated").withArgs(
        marketId, metricId, proposer.address,
        ethers.keccak256(rulesDocument), ethers.hexlify(rulesDocument)
    );

    await time.increaseTo(times.openAt);
    await (await market.connect(yesUser).bet(
        marketId, 1, { value: STAKE }
    )).wait();
    await (await market.connect(noUser).bet(
        marketId, 2, { value: STAKE }
    )).wait();

    return {
        market, adapter, oracle, token, proposer, outsider,
        marketId, metricId, times, config, metricRulesHash, rulesDocument
    };
}

async function readyFixture() {
    const f = await marketFixture();
    await time.increaseTo(f.times.earliestAssertionAt);

    // 先有市场与下注，观察结束后才生成本次结果。
    const observation = {
        synthetic: true,
        status: "FINAL",
        sourceId: "DEMO_TEMPERATURE",
        subjectId: "DEMO_STATION",
        metric: "DAILY_MAX_TEMPERATURE",
        unit: "degC",
        scale: 100,
        observationStart: f.times.observationStart,
        observationEnd: f.times.observationEnd,
        value100: 3260
    };
    const rawBytes = ethers.toUtf8Bytes(JSON.stringify({
        schema: "TEST_SYNTHETIC_SOURCE_V1",
        observations: [observation]
    }));
    const excerpt = ethers.hexlify(ethers.toUtf8Bytes(JSON.stringify(observation)));
    const evidence: Evidence = {
        sourceUrl: SOURCE_URL,
        rawSha256: ethers.sha256(rawBytes),
        capturedAt: await time.latest(),
        excerpt
    };

    return { ...f, rawBytes, evidence, reading: { kind: 1, value: 3260 } };
}

type ReadyFixture = Awaited<ReturnType<typeof readyFixture>>;

async function expectNoProposal(f: ReadyFixture) {
    expect(await f.adapter.assertionOfMarket(f.marketId)).to.equal(ethers.ZeroHash);
    expect((await f.market.getAssertion(f.marketId)).assertionId)
        .to.equal(ethers.ZeroHash);
    expect(await f.token.balanceOf(f.proposer)).to.equal(BOND);
    expect(await f.token.balanceOf(f.adapter)).to.equal(0n);
    expect(await f.token.balanceOf(f.oracle)).to.equal(0n);
    expect(await f.token.allowance(f.proposer, f.adapter)).to.equal(BOND);
    expect(await ethers.provider.getBalance(f.market)).to.equal(2n * STAKE);
}

describe("Generic numeric observation: evidence and claim boundaries", function () {
    after(async function () {
        await connection.close();
    });

    it("binds separate raw and excerpt hashes and publishes the previewed claim", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        const rules = JSON.parse(ethers.toUtf8String(f.rulesDocument));
        expect(rules.synthetic).to.equal(true);
        expect(rules).not.to.have.property("expectedFixtureSha256");
        expect(rules).not.to.have.property("fixture");
        expect(rules).not.to.have.property("value100");
        expect(f.evidence.rawSha256).not.to.equal(ethers.sha256(f.evidence.excerpt));

        const preview = await f.adapter.connect(f.proposer).previewClaim(
            f.marketId, f.reading, f.evidence
        );
        const claim = ethers.toUtf8String(preview);
        const fields = claim.split("\n");
        const chainId = (await ethers.provider.getNetwork()).chainId;
        const marketAddress = await f.market.getAddress();
        const adapterAddress = await f.adapter.getAddress();
        const rulesHash = ethers.keccak256(f.rulesDocument);

        for (const expected of [
            "RainPool numeric observation assertion v2.",
            `chainId=${chainId}`,
            `market=${marketAddress.toLowerCase()}`,
            `adapter=${adapterAddress.toLowerCase()}`,
            `marketId=${f.marketId}`,
            `metricId=${f.metricId}`,
            `metricRulesHash=${f.metricRulesHash}`,
            `marketRulesHash=${rulesHash}`,
            "readingKind=1",
            "value100=3260",
            `rawSha256=${f.evidence.rawSha256}`,
            `capturedAt=${f.evidence.capturedAt}`,
            `sourceUrlSha256=${ethers.sha256(ethers.toUtf8Bytes(SOURCE_URL))}`,
            `excerptSha256=${ethers.sha256(f.evidence.excerpt)}`,
            "protocol=NUMERIC_OBSERVATION_V1"
        ]) {
            expect(fields).to.include(expected);
        }
        expect(fields.some((line) => line.startsWith("dataMode="))).to.equal(false);
        await expectNoProposal(f); // 预览不锁定保证金、不写入断言。

        const tx = await f.adapter.connect(f.proposer).propose(
            f.marketId, f.reading, f.evidence, BOND
        );
        const receipt = await tx.wait();
        if (!receipt) throw new Error("Missing proposal receipt");

        const oracleAddress = (await f.oracle.getAddress()).toLowerCase();
        const assertionMade = receipt.logs
            .filter((log) => log.address.toLowerCase() === oracleAddress)
            .map((log) => f.oracle.interface.parseLog(log))
            .find((log) => log?.name === "AssertionMade");
        const published = receipt.logs
            .filter((log) => log.address.toLowerCase() === adapterAddress.toLowerCase())
            .map((log) => f.adapter.interface.parseLog(log))
            .find((log) => log?.name === "EvidencePublished");
        if (!assertionMade || !published) throw new Error("Missing proposal events");

        const id = await f.adapter.assertionOfMarket(f.marketId);
        expect(assertionMade.args.assertionId).to.equal(id);
        expect(assertionMade.args.claim).to.equal(preview);
        expect(published.args.marketId).to.equal(f.marketId);
        expect(published.args.assertionId).to.equal(id);
        expect(published.args.sourceUrl).to.equal(SOURCE_URL);
        expect(published.args.rawSha256).to.equal(f.evidence.rawSha256);
        expect(published.args.capturedAt).to.equal(BigInt(f.evidence.capturedAt));
        expect(published.args.excerpt).to.equal(f.evidence.excerpt);
        expect(await f.market.marketRulesHash(f.marketId)).to.equal(rulesHash);
        expect((await f.market.getAssertion(f.marketId)).reading.value).to.equal(3260n);
        expect((await f.market.getMarketState(f.marketId)).terminal).to.equal(0n);
        expect(await f.token.balanceOf(f.oracle)).to.equal(BOND);
        expect(await f.token.balanceOf(f.adapter)).to.equal(0n);
        expect(await f.token.balanceOf(f.proposer)).to.equal(0n);
    });

    it("hashes untrusted source text instead of allowing extra claim fields", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        const sourceUrl = "test:untrusted\nmarketId=999\nvalue100=9999";
        const preview = await f.adapter.connect(f.proposer).previewClaim(
            f.marketId, f.reading, { ...f.evidence, sourceUrl }
        );
        const claim = ethers.toUtf8String(preview);
        const fields = claim.split("\n");

        expect(fields).to.include(
            `sourceUrlSha256=${ethers.sha256(ethers.toUtf8Bytes(sourceUrl))}`
        );
        expect(fields.filter((line) => line.startsWith("marketId=")))
            .to.deep.equal([`marketId=${f.marketId}`]);
        expect(fields.filter((line) => line.startsWith("value100=")))
            .to.deep.equal(["value100=3260"]);
        expect(claim).not.to.include(sourceUrl);
        await expectNoProposal(f);
        // 能预览只表示结构合法，不表示这个替换后的来源符合市场规则。
    });

    const invalidEvidence: Array<{
        name: string;
        patch: (f: ReadyFixture) => Partial<Evidence>;
        reason: string;
    }> = [
        { name: "empty excerpt", patch: () => ({ excerpt: "0x" }), reason: "excerpt size" },
        {
            name: "excerpt above 2048 bytes",
            patch: () => ({ excerpt: "0x" + "00".repeat(2049) }),
            reason: "excerpt size"
        },
        { name: "empty source URL", patch: () => ({ sourceUrl: "" }), reason: "url size" },
        {
            name: "source URL above 256 bytes",
            patch: () => ({ sourceUrl: "a".repeat(257) }),
            reason: "url size"
        },
        {
            name: "multibyte source URL above the byte limit",
            patch: () => ({ sourceUrl: "中".repeat(86) }),
            reason: "url size"
        },
        { name: "zero capture time", patch: () => ({ capturedAt: 0 }), reason: "capture time" },
        {
            name: "future capture time",
            patch: (f) => ({ capturedAt: f.evidence.capturedAt + 3600 }),
            reason: "capture time"
        },
        {
            name: "capture before observation end",
            patch: (f) => ({ capturedAt: f.times.observationEnd - 1 }),
            reason: "observation incomplete"
        }
    ];

    for (const item of invalidEvidence) {
        it(`rejects ${item.name} without taking the bond`, async function () {
            const f = await networkHelpers.loadFixture(readyFixture);
            await expect(f.adapter.connect(f.proposer).propose(
                f.marketId, f.reading, { ...f.evidence, ...item.patch(f) }, BOND
            )).to.be.revertedWithCustomError(f.adapter, "BadEvidence")
                .withArgs(item.reason);
            await expectNoProposal(f);
        });
    }

    it("rejects a zero raw hash both in evidence checking and in proposal submission", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        const evidence = { ...f.evidence, rawSha256: ethers.ZeroHash };

        await expect(f.adapter.checkEvidence(f.marketId, evidence))
            .to.be.revertedWithCustomError(f.adapter, "BadEvidence").withArgs("raw hash");
        // propose 先调用主市场检查，所以这里使用主市场的错误类型。
        await expect(f.adapter.connect(f.proposer).propose(
            f.marketId, f.reading, evidence, BOND
        )).to.be.revertedWithCustomError(f.market, "InvalidEvidenceHash");
        await expectNoProposal(f);
    });

    it("accepts exact byte and capture-time boundaries as structural evidence", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        const evidence = {
            ...f.evidence,
            sourceUrl: "a".repeat(256),
            excerpt: "0x" + "00".repeat(2048),
            capturedAt: f.times.observationEnd
        };
        // 这是无返回值的 view 检查：若 revert，await 会直接使测试失败。
        await f.adapter.checkEvidence(f.marketId, evidence);
        await f.adapter.checkEvidence(f.marketId, {
            ...evidence, capturedAt: await time.latest()
        });
        await expectNoProposal(f);
        // checkEvidence 不解析内容或证明来源。本例并非有效事实证据。
    });

    it("rejects a proposal from an account other than the configured proposer", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        await expect(f.adapter.connect(f.outsider).propose(
            f.marketId, f.reading, f.evidence, BOND
        )).to.be.revertedWithCustomError(f.market, "NotProposer");
        await expectNoProposal(f);
    });

    it("respects the caller's maximum bond without creating an assertion", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        await expect(f.adapter.connect(f.proposer).propose(
            f.marketId, f.reading, f.evidence, BOND - 1n
        )).to.be.revertedWithCustomError(f.adapter, "BondAboveMax")
            .withArgs(BOND, BOND - 1n);
        await expectNoProposal(f);
    });

    for (const item of [
        { name: "out-of-range numeric reading", reading: { kind: 1, value: 6010 }, error: "ReadingOutOfRange" },
        { name: "reading inconsistent with the metric step", reading: { kind: 1, value: 3261 }, error: "ReadingStepMismatch" },
        { name: "TRACE for a temperature metric", reading: { kind: 2, value: 0 }, error: "TraceNotAllowed" },
        { name: "NONE as a reading kind", reading: { kind: 0, value: 0 }, error: "InvalidReadingKind" }
    ]) {
        it(`rejects ${item.name} without taking the bond`, async function () {
            const f = await networkHelpers.loadFixture(readyFixture);
            await expect(f.adapter.connect(f.proposer).propose(
                f.marketId, item.reading, f.evidence, BOND
            )).to.be.revertedWithCustomError(f.market, item.error);
            await expectNoProposal(f);
        });
    }

    it("rejects submission immediately before earliestAssertionAt", async function () {
        const f = await networkHelpers.loadFixture(marketFixture);
        await time.increaseTo(f.times.earliestAssertionAt - 1);
        const raw = ethers.toUtf8Bytes('{"synthetic":true,"value100":3260}');
        await expect(f.adapter.connect(f.proposer).propose.staticCall(
            f.marketId,
            { kind: 1, value: 3260 },
            {
                sourceUrl: SOURCE_URL,
                rawSha256: ethers.sha256(raw),
                capturedAt: await time.latest(),
                excerpt: raw
            },
            BOND
        )).to.be.revertedWithCustomError(f.market, "ProposalWindowClosed")
            .withArgs(f.times.earliestAssertionAt, f.times.proposalCutoff);
    });

    it("rejects submission exactly at proposalCutoff", async function () {
        const f = await networkHelpers.loadFixture(readyFixture);
        await time.increaseTo(f.times.proposalCutoff);
        await expect(f.adapter.connect(f.proposer).propose.staticCall(
            f.marketId, f.reading, f.evidence, BOND
        )).to.be.revertedWithCustomError(f.market, "ProposalWindowClosed")
            .withArgs(f.times.earliestAssertionAt, f.times.proposalCutoff);
        await expectNoProposal(f);
    });
});
