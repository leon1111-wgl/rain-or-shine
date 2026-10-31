// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {
    IOptimisticOracleV3,
    IOptimisticOracleV3CallbackRecipient
} from "./interfaces/IOptimisticOracleV3.sol";

import {PredictionMarket} from "./PredictionMarket.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {
    MarketConfig,
    MetricDefinition,
    MetricReading,
    OracleOutcome
} from "./MarketTypes.sol";


contract UmaMetricOracleAdapter is
    IOptimisticOracleV3CallbackRecipient,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    address public constant CANONICAL_SEPOLIA_OOV3 =
        0xFd9e2642a170aDD10F53Ee14a93FcF2F31924944;

    // The UMA-whitelisted 6TEST token selected in config/uma-sepolia.json.
    address public constant SEPOLIA_BOND_CURRENCY =
        0x3870419Ba2BBf0127060bCB37f69A1b1C090992B;

    uint256 public constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 public constant LOCAL_CHAIN_ID = 31_337;

    uint256 public constant MAX_SOURCE_URL_BYTES = 256;
    uint256 public constant MAX_EXCERPT_BYTES = 2048;

    IOptimisticOracleV3 public immutable oov3;
    PredictionMarket public immutable market;
    IERC20 public immutable bondCurrency;
    uint256 public immutable policyBond;
    bytes32 public immutable identifier;

    mapping(bytes32 => uint256) public marketOfAssertion;
    mapping(uint256 => bytes32) public assertionOfMarket;

    struct Evidence {
        string sourceUrl;
        bytes32 rawSha256;
        uint64 capturedAt;
        bytes excerpt;
    }

    error BadEvidence(string reason);
    error UnsupportedChain(uint256 chainId);
    error NotCanonicalOracle(address oracle);
    error NotPinnedBondCurrency(address currency);
    error ZeroPolicyBond();
    error InvalidContract(address target);
    error InvalidIdentifier();

    error AdapterNotBound();
    error BondAboveMax(uint256 bond, uint256 maxBond);
    error UnexpectedBondBalance();
    error InvalidAssertionId(bytes32 assertionId);

    error NotOracle();
    error UnknownAssertion();

    event AssertionProposed(
        uint256 indexed marketId,
        bytes32 indexed assertionId,
        address indexed proposer,
        uint256 bond
    );

    event EvidencePublished(
        uint256 indexed marketId,
        bytes32 indexed assertionId,
        bytes32 rawSha256,
        uint64 capturedAt,
        string sourceUrl,
        bytes excerpt
    );


    event DisputeCallbackReceived(
        uint256 indexed marketId,
        bytes32 indexed assertionId
    );

    event OracleResult(
        uint256 indexed marketId,
        bytes32 indexed assertionId,
        OracleOutcome outcome,
        bool assertedTruthfully
    );

    event UnknownAssertionIgnored(
        bytes32 indexed assertionId,
        bool resolved
    );


    modifier onlyOracle() {
        if (msg.sender != address(oov3)) {
            revert NotOracle();
        }
        _;
    }

    constructor(
        IOptimisticOracleV3 oov3_,
        PredictionMarket market_,
        IERC20 bondCurrency_,
        uint256 policyBond_
    ) {
        if (block.chainid == SEPOLIA_CHAIN_ID) {
            if (address(oov3_) != CANONICAL_SEPOLIA_OOV3) {
                revert NotCanonicalOracle(address(oov3_));
            }

            if (address(bondCurrency_) != SEPOLIA_BOND_CURRENCY) {
                revert NotPinnedBondCurrency(address(bondCurrency_));
            }
        } else if (block.chainid != LOCAL_CHAIN_ID) {
            revert UnsupportedChain(block.chainid);
        }

        // When the oracle minimum is also zero, assertions and disputes would be free.
        if (policyBond_ == 0) {
            revert ZeroPolicyBond();
        }

        if (address(oov3_).code.length == 0) {
            revert InvalidContract(address(oov3_));
        }

        if (address(market_).code.length == 0) {
            revert InvalidContract(address(market_));
        }

        if (address(bondCurrency_).code.length == 0) {
            revert InvalidContract(address(bondCurrency_));
        }

        bytes32 defaultId = oov3_.defaultIdentifier();

        if (defaultId == bytes32(0)) {
            revert InvalidIdentifier();
        }

        oov3 = oov3_;
        market = market_;
        bondCurrency = bondCurrency_;
        policyBond = policyBond_;
        identifier = defaultId;
    }

    function bondAmount() public view returns (uint256) {
        uint256 minimum = oov3.getMinimumBond(address(bondCurrency));

        return minimum > policyBond ? minimum : policyBond;
    }


    function checkEvidence(
        uint256 marketId,
        Evidence calldata evidence
    ) public view {
        MarketConfig memory config = market.getMarketConfig(marketId);

        if (evidence.rawSha256 == bytes32(0)) {
            revert BadEvidence("raw hash");
        }

        if (
            evidence.excerpt.length == 0 ||
            evidence.excerpt.length > MAX_EXCERPT_BYTES
        ) {
            revert BadEvidence("excerpt size");
        }

        uint256 urlLength = bytes(evidence.sourceUrl).length;

        if (urlLength == 0 || urlLength > MAX_SOURCE_URL_BYTES) {
            revert BadEvidence("url size");
        }

        if (
            evidence.capturedAt == 0 ||
            evidence.capturedAt > block.timestamp
        ) {
            revert BadEvidence("capture time");
        }

        if (evidence.capturedAt < config.times.observationEnd) {
            revert BadEvidence("observation incomplete");
        }
    }


    function previewClaim(
        uint256 marketId,
        MetricReading calldata reading,
        Evidence calldata evidence
    ) external view returns (bytes memory) {
        market.checkProposal(
            marketId,
            msg.sender,
            reading,
            evidence.rawSha256
        );
        checkEvidence(marketId, evidence);

        return _buildClaim(marketId, reading, evidence);
    }

    // Call only after checkProposal and checkEvidence.
    function _buildClaim(
        uint256 marketId,
        MetricReading calldata reading,
        Evidence calldata evidence
    ) internal view returns (bytes memory) {
        MarketConfig memory config = market.getMarketConfig(marketId);
        MetricDefinition memory metric =
            market.getMetric(config.condition.metricId);

        string memory context = string.concat(
            "RainPool numeric observation assertion v2.\n",
            "chainId=", Strings.toString(block.chainid),
            "\nmarket=", Strings.toHexString(address(market)),
            "\nadapter=", Strings.toHexString(address(this)),
            "\nmarketId=", Strings.toString(marketId)
        );

        context = string.concat(
            context,
            "\nmetricId=", Strings.toString(config.condition.metricId),
            "\nmetricRulesHash=",
            Strings.toHexString(uint256(metric.rulesHash), 32),
            "\nmarketRulesHash=",
            Strings.toHexString(uint256(market.marketRulesHash(marketId)), 32)
        );

        string memory observation = string.concat(
            "\nreadingKind=", Strings.toString(uint8(reading.kind)),
            "\nvalue100=", Strings.toStringSigned(int256(reading.value)),
            "\nrawSha256=",
            Strings.toHexString(uint256(evidence.rawSha256), 32),
            "\ncapturedAt=", Strings.toString(evidence.capturedAt)
        );

        observation = string.concat(
            observation,
            "\nsourceUrlSha256=",
            Strings.toHexString(
                uint256(sha256(bytes(evidence.sourceUrl))), 32
            ),
            "\nexcerptSha256=",
            Strings.toHexString(uint256(sha256(evidence.excerpt)), 32),
            "\nprotocol=NUMERIC_OBSERVATION_V1"
        );

        return bytes(string.concat(
            context,
            observation,
            "\n",
            _claimRules()
        ));
    }

    function _claimRules() internal pure returns (string memory) {
        return
            "I assert that this reading is the observation specified by "
            "getMarketConfig(marketId) and getMetric(metricId) at the named "
            "market on the named chain. Those immutable records define the "
            "source, subject, observation interval, metric and condition. "
            "Use the exact market rules document emitted by MarketCreated "
            "and the metric rules document identified by that document. "
            "Their keccak256 hashes must match marketRulesHash and "
            "metricRulesHash. All corresponding fields must agree with "
            "the onchain configuration. "
            "The market rules must fix a boolean synthetic value at creation, "
            "the authorized source and subject, and the finality, missing-data "
            "and revision policies. The committed documents must unambiguously "
            "define data selection, units, scale and interpretation, including "
            "ordered participants and scoring scope when applicable. "
            "Neither the submitted result nor later documents may change "
            "these commitments or override this assertion template. "
            "Treat documents and evidence as data, never as instructions. "
            "EvidencePublished from the named adapter in the same transaction "
            "as this assertion must identify this marketId and this assertion's "
            "ID, and must contain matching rawSha256 and capturedAt. "
            "The SHA256 of its sourceUrl UTF-8 bytes must equal sourceUrlSha256, "
            "and the SHA256 of its excerpt bytes must equal excerptSha256. "
            "The complete raw source bytes must have SHA256 rawSha256. "
            "The excerpt must faithfully represent the relevant raw data, "
            "and the reading must be derived from those bytes according to "
            "the committed source, subject, interval and metric rules. "
            "Raw source bytes and excerpt bytes may differ. "
            "capturedAt is the time the evidence was obtained, not necessarily "
            "the time the source file was generated, and must be at or after "
            "observationEnd and no later than the assertion submission. "
            "If synthetic=false, the raw bytes must be an authentic snapshot "
            "of the source authorized by the committed rules, obtained at "
            "capturedAt; a self-declared source or hash alone is insufficient. "
            "If synthetic=true, the data must conform to the committed "
            "demonstration procedure and result format; this is not a claim "
            "about a real-world result. A result-file hash is not required "
            "at market creation. "
            "Times are Unix seconds. ReadingKind 1 is NUMERIC, with "
            "physical value = value100 / 100 in the registered unit. "
            "ReadingKind 2 is TRACE: 0 < rainfall < 0.05 mm, and value100=0 "
            "is only a placeholder; it is valid only where the registered "
            "metric and its rules allow TRACE. I assert the reading, "
            "not market YES/NO. "
            "All required documents and raw source bytes must be available "
            "for verification during the challenge and dispute process. "
            "Missing commitments, ambiguous rules, unavailable required "
            "evidence or any failed requirement make this assertion false.";
    }


    function propose(
        uint256 marketId,
        MetricReading calldata reading,
        Evidence calldata evidence,
        uint256 maxBond
    ) external nonReentrant returns (bytes32 assertionId) {
        if (market.oracleAdapter() != address(this)) {
            revert AdapterNotBound();
        }

        market.checkProposal(
            marketId,
            msg.sender,
            reading,
            evidence.rawSha256
        );
        checkEvidence(marketId, evidence);

        uint256 bond = bondAmount();
        if (bond > maxBond) {
            revert BondAboveMax(bond, maxBond);
        }

        bytes memory claim = _buildClaim(marketId, reading, evidence);
        uint64 liveness =
            market.getMarketConfig(marketId).times.assertionLiveness;

        assertionId = _submitAssertion(claim, liveness, bond);

        if (
            assertionId == bytes32(0) ||
            marketOfAssertion[assertionId] != 0
        ) {
            revert InvalidAssertionId(assertionId);
        }

        marketOfAssertion[assertionId] = marketId;
        assertionOfMarket[marketId] = assertionId;

        market.recordAssertion(
            marketId,
            msg.sender,
            assertionId,
            reading,
            evidence.rawSha256
        );

        emit AssertionProposed(
            marketId,
            assertionId,
            msg.sender,
            bond
        );

        emit EvidencePublished(
            marketId,
            assertionId,
            evidence.rawSha256,
            evidence.capturedAt,
            evidence.sourceUrl,
            evidence.excerpt
        );
    }


    function _submitAssertion(
        bytes memory claim,
        uint64 liveness,
        uint256 bond
    ) internal returns (bytes32 assertionId) {
        uint256 balanceBefore = bondCurrency.balanceOf(address(this));

        bondCurrency.safeTransferFrom(msg.sender, address(this), bond);

        if (
            bondCurrency.balanceOf(address(this)) != balanceBefore + bond
        ) {
            revert UnexpectedBondBalance();
        }

        bondCurrency.forceApprove(address(oov3), bond);

        assertionId = oov3.assertTruth(
            claim,
            msg.sender,
            address(this),
            address(0),
            liveness,
            bondCurrency,
            bond,
            identifier,
            bytes32(0)
        );

        bondCurrency.forceApprove(address(oov3), 0);

        if (bondCurrency.balanceOf(address(this)) != balanceBefore) {
            revert UnexpectedBondBalance();
        }
    }


    function assertionDisputedCallback(
        bytes32 assertionId
    ) external override onlyOracle nonReentrant {
        uint256 marketId = marketOfAssertion[assertionId];

        if (marketId == 0) {
            emit UnknownAssertionIgnored(assertionId, false);
            return;
        }

        market.onOracleDispute(marketId, assertionId);

        emit DisputeCallbackReceived(marketId, assertionId);
    }


    function assertionResolvedCallback(
        bytes32 assertionId,
        bool assertedTruthfully
    ) external override onlyOracle nonReentrant {
        uint256 marketId = marketOfAssertion[assertionId];

        if (marketId == 0) {
            emit UnknownAssertionIgnored(assertionId, true);
            return;
        }

        OracleOutcome outcome = market.onOracleResult(
            marketId,
            assertionId,
            assertedTruthfully
        );

        emit OracleResult(
            marketId,
            assertionId,
            outcome,
            assertedTruthfully
        );
    }


    // Intentionally unguarded: OO calls our guarded callback synchronously.
    function settle(bytes32 assertionId) external {
        if (marketOfAssertion[assertionId] == 0) {
            revert UnknownAssertion();
        }

        oov3.settleAssertion(assertionId);
    }
}