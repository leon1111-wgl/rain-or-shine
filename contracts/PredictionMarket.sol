// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;


import {
    MarketConfig,
    PoolTimes,
    MarketState,
    Position,
    Side,
    Terminal,
    RefundReason,
    ClaimType,
    MetricDefinition,
    MetricReading,
    MarketAssertionRecord,
    ReadingKind,
    OracleOutcome
} from "./MarketTypes.sol";

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {
    ReentrancyGuardTransient
} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {MetricRegistry} from "./MetricRegistry.sol";
import {ConditionLib} from "./ConditionLib.sol";

import {
    IMarketOracleAdapter
} from "./interfaces/IMarketOracleAdapter.sol";


contract PredictionMarket is MetricRegistry, ReentrancyGuardTransient {
    uint256 public constant MAX_RULES_DOCUMENT_BYTES = 4096;

    uint256 public marketCount;

    uint256 public constant MIN_BET = 0.001 ether;

    // An undisputed assertion made at the last allowed second still matures
    // at least MIN_SETTLE_WINDOW before refundAt, so it can be settled first.
    uint256 public constant MIN_LIVENESS = 60 seconds;
    uint256 public constant MIN_SETTLE_WINDOW = 1 hours;

    address public oracleAdapter;

    mapping(uint256 => MarketState) private _marketStates;

    mapping(uint256 => mapping(address => Position)) private _positions;

    mapping(uint256 => MarketConfig) private _marketConfigs;
    mapping(uint256 => bytes32) public marketRulesHash;


    mapping(uint256 => MarketAssertionRecord) private _marketAssertions;

    mapping(bytes32 => uint256) public marketOfAssertion;

    error NotProposer();
    error AlreadyProposed();
    error ProposalWindowClosed(
        uint64 earliestAssertionAt,
        uint64 proposalCutoff
    );
    error InvalidEvidenceHash();
    error IndeterminateReading();

    error UnknownMarket(uint256 marketId);
    error InvalidMarketConfig(string reason);
    error BadRulesDocument();

    error InvalidSide();
    error BetTooSmall(uint256 value, uint256 minimum);
    error BettingNotOpen(uint64 openAt);
    error BettingClosed(uint64 closeAt);
    error MarketFinal(Terminal state);
    error SideLocked(Side locked);
    error ProposerCannotBet();

    error RefundNotAvailable();
    error NothingToClaim();
    error TransferFailed();
    error MarketFundsExceeded();

    error OracleAdapterNotSet();
    error OracleAdapterAlreadySet();
    error InvalidOracleAdapter();
    error NotOracleAdapter();
    error UnknownAssertion();
    error AssertionAlreadyUsed();

    event MarketRefundActivated(
        uint256 indexed marketId,
        RefundReason indexed reason,
        address indexed caller
    );

    event Claimed(
        uint256 indexed marketId,
        address indexed account,
        uint256 amount,
        ClaimType claimType
    );

    event MarketCreated(
        uint256 indexed marketId,
        uint32 indexed metricId,
        address indexed proposer,
        bytes32 rulesHash,
        bytes rulesDocument
    );

    event BetPlaced(
        uint256 indexed marketId,
        address indexed account,
        Side indexed side,
        uint256 value,
        uint256 cumulativeStake,
        uint256 yesTotal,
        uint256 noTotal
    );

    event OracleAdapterSet(address indexed adapter);

    event AssertionRecorded(
        uint256 indexed marketId,
        bytes32 indexed assertionId,
        ReadingKind kind,
        int32 value,
        bytes32 rawSha256
    );

    event AssertionDisputed(
        uint256 indexed marketId,
        bytes32 indexed assertionId
    );

    event OracleResultRecorded(
        uint256 indexed marketId,
        bytes32 indexed assertionId,
        OracleOutcome outcome,
        bool assertedTruthfully
    );

    event MarketResolved(
        uint256 indexed marketId,
        Terminal indexed terminal,
        bytes32 indexed assertionId,
        ReadingKind kind,
        int32 value
    );

    constructor(address initialAdmin) MetricRegistry(initialAdmin) {}

    function createMarket(
        MarketConfig calldata config,
        bytes calldata rulesDocument
    ) external onlyMetricAdmin returns (uint256 marketId) {
        if (oracleAdapter == address(0)) {
            revert OracleAdapterNotSet();
        }

        if (
            rulesDocument.length == 0 ||
            rulesDocument.length > MAX_RULES_DOCUMENT_BYTES
        ) {
            revert BadRulesDocument();
        }

        _validateMarketConfig(config);

        marketId = ++marketCount;
        _marketConfigs[marketId] = config;

        bytes32 rulesHash = keccak256(rulesDocument);
        marketRulesHash[marketId] = rulesHash;

        emit MarketCreated(
            marketId,
            config.condition.metricId,
            config.proposer,
            rulesHash,
            rulesDocument
        );
    }


    function getMarketConfig(
        uint256 marketId
    ) public view returns (MarketConfig memory) {
        _requireMarket(marketId);

        return _marketConfigs[marketId];
    }

    function _validateMarketConfig(
        MarketConfig calldata config
    ) private view {
        if (
            config.proposer == address(0) ||
            config.sourceId == bytes32(0) ||
            config.subjectId == bytes32(0)
        ) {
            revert InvalidMarketConfig("empty field");
        }

        MetricDefinition memory metric = getMetric(config.condition.metricId);
        ConditionLib.validateForMetric(metric, config.condition);

        PoolTimes calldata t = config.times;

        bool ordered =
            block.timestamp <= t.openAt &&
            t.openAt < t.closeAt &&
            t.closeAt <= t.observationStart &&
            t.observationStart < t.observationEnd &&
            t.observationEnd <= t.earliestAssertionAt &&
            t.earliestAssertionAt < t.proposalCutoff &&
            t.proposalCutoff < t.refundAt;

        if (!ordered) {
            revert InvalidMarketConfig("time order");
        }

        if (t.assertionLiveness < MIN_LIVENESS) {
            revert InvalidMarketConfig("assertion liveness");
        }

        if (
            uint256(t.refundAt) <
            uint256(t.proposalCutoff) +
                uint256(t.assertionLiveness) +
                MIN_SETTLE_WINDOW
        ) {
            revert InvalidMarketConfig("settlement buffer");
        }
    }

    function _requireMarket(uint256 marketId) private view {
        if (marketId == 0 || marketId > marketCount) {
            revert UnknownMarket(marketId);
        }
    }


    function bet(
        uint256 marketId,
        Side side
    ) external payable nonReentrant {
        _requireMarket(marketId);

        if (side != Side.YES && side != Side.NO) {
            revert InvalidSide();
        }

        if (msg.value < MIN_BET) {
            revert BetTooSmall(msg.value, MIN_BET);
        }

        MarketState storage state = _marketStates[marketId];
        PoolTimes storage times = _marketConfigs[marketId].times;
        Position storage position = _positions[marketId][msg.sender];

        if (state.terminal != Terminal.UNRESOLVED) {
            revert MarketFinal(state.terminal);
        }

        if (block.timestamp < times.openAt) {
            revert BettingNotOpen(times.openAt);
        }

        if (block.timestamp >= times.closeAt) {
            revert BettingClosed(times.closeAt);
        }

        // The only account that can propose must not hold a position: it
        // could otherwise withhold an unfavourable result and force a refund.
        if (msg.sender == _marketConfigs[marketId].proposer) {
            revert ProposerCannotBet();
        }

        if (position.side != Side.NONE && position.side != side) {
            revert SideLocked(position.side);
        }

        if (position.side == Side.NONE) {
            position.side = side;

            if (side == Side.YES) {
                state.yesAccounts++;
            } else {
                state.noAccounts++;
            }
        }

        position.stake += msg.value;

        if (side == Side.YES) {
            state.yesTotal += msg.value;
        } else {
            state.noTotal += msg.value;
        }

        emit BetPlaced(
            marketId,
            msg.sender,
            side,
            msg.value,
            position.stake,
            state.yesTotal,
            state.noTotal
        );
    }


    function getMarketState(
        uint256 marketId
    ) external view returns (MarketState memory) {
        _requireMarket(marketId);

        return _marketStates[marketId];
    }

    function getPosition(
        uint256 marketId,
        address account
    ) external view returns (Position memory) {
        _requireMarket(marketId);

        return _positions[marketId][account];
    }


    function getEffectiveState(
        uint256 marketId
    ) public view returns (Terminal terminal, RefundReason reason) {
        _requireMarket(marketId);

        MarketState storage state = _marketStates[marketId];
        PoolTimes storage times = _marketConfigs[marketId].times;

        if (state.terminal != Terminal.UNRESOLVED) {
            return (state.terminal, state.refundReason);
        }

        if (
            block.timestamp >= times.closeAt &&
            (state.yesTotal == 0 || state.noTotal == 0)
        ) {
            reason = state.yesTotal + state.noTotal == 0
                ? RefundReason.EMPTY
                : RefundReason.SINGLE_SIDED;

            return (Terminal.REFUND, reason);
        }

        MarketAssertionRecord storage record = _marketAssertions[marketId];

        // A market allows one assertion. Once the oracle rejects it, no valid
        // settlement can follow, so the refund need not wait for refundAt.
        if (record.rejected) {
            return (Terminal.REFUND, RefundReason.NO_VALID_SETTLEMENT);
        }

        // Settle first. MIN_SETTLE_WINDOW makes every undisputed assertion
        // mature at least an hour before refundAt, so one still pending here
        // can be settled by anyone and its result decides the market. Only a
        // missing or disputed assertion (Sepolia has no DVM) refunds at refundAt.
        if (
            block.timestamp >= times.refundAt &&
            (
                record.assertionId == bytes32(0) ||
                record.disputed ||
                record.returned
            )
        ) {
            return (Terminal.REFUND, RefundReason.NO_VALID_SETTLEMENT);
        }

        return (Terminal.UNRESOLVED, RefundReason.NONE);
    }


    function activateRefund(uint256 marketId) external nonReentrant {
        _requireMarket(marketId);

        MarketState storage state = _marketStates[marketId];

        if (state.terminal != Terminal.UNRESOLVED) {
            revert MarketFinal(state.terminal);
        }

        (Terminal terminal, RefundReason reason) = getEffectiveState(marketId);

        if (terminal != Terminal.REFUND) {
            revert RefundNotAvailable();
        }

        _activateRefund(marketId, reason);
    }

    function _activateRefund(
        uint256 marketId,
        RefundReason reason
    ) private {
        MarketState storage state = _marketStates[marketId];

        state.terminal = Terminal.REFUND;
        state.refundReason = reason;

        emit MarketRefundActivated(marketId, reason, msg.sender);
    }


    function _entitlement(
        uint256 marketId,
        Position memory position,
        Terminal terminal
    ) private view returns (uint256 amount, ClaimType claimType) {
        if (position.stake == 0) {
            return (0, ClaimType.WINNINGS);
        }

        if (terminal == Terminal.REFUND) {
            return (position.stake, ClaimType.REFUND);
        }

        MarketState storage state = _marketStates[marketId];
        uint256 total = state.yesTotal + state.noTotal;

        if (terminal == Terminal.YES && position.side == Side.YES) {
            return (
                Math.mulDiv(position.stake, total, state.yesTotal),
                ClaimType.WINNINGS
            );
        }

        if (terminal == Terminal.NO && position.side == Side.NO) {
            return (
                Math.mulDiv(position.stake, total, state.noTotal),
                ClaimType.WINNINGS
            );
        }

        return (0, ClaimType.WINNINGS);
    }


    function claim(
        uint256 marketId
    ) external nonReentrant returns (uint256 amount) {
        (Terminal terminal, RefundReason reason) = getEffectiveState(marketId);
        MarketState storage state = _marketStates[marketId];

        if (
            terminal == Terminal.REFUND &&
            state.terminal == Terminal.UNRESOLVED
        ) {
            _activateRefund(marketId, reason);
        }

        Position storage position = _positions[marketId][msg.sender];

        if (position.claimed) {
            revert NothingToClaim();
        }

        ClaimType claimType;
        (amount, claimType) = _entitlement(marketId, position, terminal);

        if (amount == 0) {
            revert NothingToClaim();
        }

        uint256 total = state.yesTotal + state.noTotal;

        if (
            state.paidOut > total ||
            amount > total - state.paidOut
        ) {
            revert MarketFundsExceeded();
        }

        position.claimed = true;
        state.paidOut += amount;

        emit Claimed(marketId, msg.sender, amount, claimType);

        (bool ok,) = payable(msg.sender).call{value: amount}("");

        if (!ok) {
            revert TransferFailed();
        }
    }


    function claimable(
        uint256 marketId,
        address account
    ) external view returns (uint256) {
        (Terminal terminal,) = getEffectiveState(marketId);
        Position memory position = _positions[marketId][account];

        if (position.claimed) {
            return 0;
        }

        (uint256 amount,) = _entitlement(marketId, position, terminal);

        return amount;
    }


    function getAssertion(
        uint256 marketId
    ) external view returns (MarketAssertionRecord memory) {
        _requireMarket(marketId);

        return _marketAssertions[marketId];
    }


    function checkProposal(
        uint256 marketId,
        address caller,
        MetricReading calldata reading,
        bytes32 rawSha256
    ) public view returns (ConditionLib.ConditionValidationResult result) {
        _requireMarket(marketId);

        MarketConfig storage config = _marketConfigs[marketId];

        if (caller != config.proposer) {
            revert NotProposer();
        }

        if (_marketAssertions[marketId].assertionId != bytes32(0)) {
            revert AlreadyProposed();
        }

        (Terminal terminal,) = getEffectiveState(marketId);

        if (terminal != Terminal.UNRESOLVED) {
            revert MarketFinal(terminal);
        }

        PoolTimes storage times = config.times;

        if (
            block.timestamp < times.earliestAssertionAt ||
            block.timestamp >= times.proposalCutoff
        ) {
            revert ProposalWindowClosed(
                times.earliestAssertionAt,
                times.proposalCutoff
            );
        }

        if (rawSha256 == bytes32(0)) {
            revert InvalidEvidenceHash();
        }

        result = ConditionLib.evaluate(
            getMetric(config.condition.metricId),
            config.condition,
            reading
        );

        if (result == ConditionLib.ConditionValidationResult.INDETERMINATE) {
            revert IndeterminateReading();
        }
    }


    modifier onlyOracleAdapter() {
        if (msg.sender != oracleAdapter) {
            revert NotOracleAdapter();
        }
        _;
    }

    function setOracleAdapter(address adapter) external onlyMetricAdmin {
        if (oracleAdapter != address(0)) {
            revert OracleAdapterAlreadySet();
        }

        if (adapter.code.length == 0) {
            revert InvalidOracleAdapter();
        }

        if (IMarketOracleAdapter(adapter).market() != address(this)) {
            revert InvalidOracleAdapter();
        }

        oracleAdapter = adapter;

        emit OracleAdapterSet(adapter);
    }

    function recordAssertion(
        uint256 marketId,
        address caller,
        bytes32 assertionId,
        MetricReading calldata reading,
        bytes32 rawSha256
    ) external onlyOracleAdapter nonReentrant {
        checkProposal(marketId, caller, reading, rawSha256);

        if (assertionId == bytes32(0)) {
            revert UnknownAssertion();
        }

        if (marketOfAssertion[assertionId] != 0) {
            revert AssertionAlreadyUsed();
        }

        _marketAssertions[marketId] = MarketAssertionRecord({
            assertionId: assertionId,
            reading: reading,
            rawSha256: rawSha256,
            proposedAt: uint64(block.timestamp),
            disputed: false,
            returned: false,
            rejected: false
        });

        marketOfAssertion[assertionId] = marketId;

        emit AssertionRecorded(
            marketId,
            assertionId,
            reading.kind,
            reading.value,
            rawSha256
        );
    }


    function _requireAssertion(
        uint256 marketId,
        bytes32 assertionId
    ) private view returns (MarketAssertionRecord storage record) {
        _requireMarket(marketId);

        record = _marketAssertions[marketId];

        if (
            assertionId == bytes32(0) ||
            record.assertionId != assertionId
        ) {
            revert UnknownAssertion();
        }
    }


    function onOracleDispute(
        uint256 marketId,
        bytes32 assertionId
    ) external onlyOracleAdapter nonReentrant {
        MarketAssertionRecord storage record =
            _requireAssertion(marketId, assertionId);

        if (record.returned || record.disputed) {
            return;
        }

        record.disputed = true;

        emit AssertionDisputed(marketId, assertionId);
    }


    function onOracleResult(
        uint256 marketId,
        bytes32 assertionId,
        bool assertedTruthfully
    ) external onlyOracleAdapter nonReentrant returns (OracleOutcome outcome) {
        MarketAssertionRecord storage record =
            _requireAssertion(marketId, assertionId);

        if (record.returned) {
            outcome = OracleOutcome.IGNORED_DUPLICATE;
        } else {
            // Read the state before recording this result: until then a
            // pending undisputed assertion keeps the market open past
            // refundAt, and a recorded rejection would read as REFUND.
            (Terminal terminal,) = getEffectiveState(marketId);

            record.returned = true;

            // Record a false result even when it is late and ignored.
            if (!assertedTruthfully) {
                record.rejected = true;
            }

            // Late: the market is already final or refundable (refund
            // activated, or a disputed assertion past refundAt). A late
            // result never changes that outcome.
            if (terminal != Terminal.UNRESOLVED) {
                outcome = OracleOutcome.IGNORED_LATE;
            } else if (!assertedTruthfully) {
                outcome = OracleOutcome.REJECTED;
            } else {
                MarketConfig storage config = _marketConfigs[marketId];

                ConditionLib.ConditionValidationResult result =
                    ConditionLib.evaluate(
                        getMetric(config.condition.metricId),
                        config.condition,
                        record.reading
                    );

                Terminal finalState;

                if (result == ConditionLib.ConditionValidationResult.YES) {
                    finalState = Terminal.YES;
                } else if (result == ConditionLib.ConditionValidationResult.NO) {
                    finalState = Terminal.NO;
                } else {
                    revert IndeterminateReading();
                }

                _marketStates[marketId].terminal = finalState;
                outcome = OracleOutcome.ACCEPTED;

                emit MarketResolved(
                    marketId,
                    finalState,
                    assertionId,
                    record.reading.kind,
                    record.reading.value
                );
            }
        }

        emit OracleResultRecorded(
            marketId,
            assertionId,
            outcome,
            assertedTruthfully
        );
    }
}