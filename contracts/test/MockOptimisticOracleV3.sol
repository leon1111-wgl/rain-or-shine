// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOptimisticOracleV3, IOptimisticOracleV3CallbackRecipient} from "../interfaces/IOptimisticOracleV3.sol";

contract MockOptimisticOracleV3 is IOptimisticOracleV3, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant DEFAULT_IDENTIFIER = "ASSERT_TRUTH";
    uint256 public constant BURNED_BOND_PERCENTAGE = 0.5e18;

    address public immutable admin;
    address public immutable store;

    mapping(address currency => bool) public isWhitelisted;
    mapping(address currency => uint256) public minimumBondOf;
    mapping(bytes32 assertionId => Assertion) private _assertions;
    mapping(bytes32 assertionId => bool) public hasSimulatedResolution;
    mapping(bytes32 assertionId => bool) public simulatedResolution;

    event SimulatedDvmResolution(bytes32 indexed assertionId, bool assertedTruthfully);

    constructor(address store_) {
        admin = msg.sender;
        store = store_;
    }

    function setCurrency(address currency, bool whitelisted, uint256 minimumBond) external {
        require(msg.sender == admin, "mock: admin only");
        isWhitelisted[currency] = whitelisted;
        minimumBondOf[currency] = minimumBond;
    }

    function defaultIdentifier() external pure returns (bytes32) {
        return DEFAULT_IDENTIFIER;
    }

    function getMinimumBond(address currency) public view returns (uint256) {
        return minimumBondOf[currency];
    }

    function getAssertion(bytes32 assertionId) external view returns (Assertion memory) {
        return _assertions[assertionId];
    }

    function getAssertionResult(bytes32 assertionId) external view returns (bool) {
        Assertion memory assertion = _assertions[assertionId];
        require(assertion.settled, "Assertion not settled");
        return assertion.settlementResolution;
    }

    function assertTruth(
        bytes memory claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external nonReentrant returns (bytes32 assertionId) {
        uint64 time = uint64(block.timestamp);
        assertionId = keccak256(
            abi.encode(claim, bond, time, liveness, currency, callbackRecipient, escalationManager, identifier, msg.sender)
        );
        require(asserter != address(0), "Asserter cant be 0");
        require(_assertions[assertionId].asserter == address(0), "Assertion already exists");
        require(identifier == DEFAULT_IDENTIFIER, "Unsupported identifier");
        require(isWhitelisted[address(currency)], "Unsupported currency");
        require(bond >= getMinimumBond(address(currency)), "Bond amount too low");
        require(escalationManager == address(0), "mock: escalation managers not modelled");

        Assertion storage assertion = _assertions[assertionId];
        assertion.escalationManagerSettings.assertingCaller = msg.sender;
        assertion.asserter = asserter;
        assertion.assertionTime = time;
        assertion.currency = currency;
        assertion.expirationTime = time + liveness;
        assertion.domainId = domainId;
        assertion.identifier = identifier;
        assertion.bond = bond;
        assertion.callbackRecipient = callbackRecipient;

        currency.safeTransferFrom(msg.sender, address(this), bond);
        _emitAssertionMade(assertionId, claim);
    }

    function _emitAssertionMade(bytes32 assertionId, bytes memory claim) private {
        Assertion storage a = _assertions[assertionId];
        emit AssertionMade(
            assertionId,
            a.domainId,
            claim,
            a.asserter,
            a.callbackRecipient,
            address(0),
            a.escalationManagerSettings.assertingCaller,
            a.expirationTime,
            a.currency,
            a.bond,
            a.identifier
        );
    }

    function disputeAssertion(bytes32 assertionId, address disputer) external nonReentrant {
        require(disputer != address(0), "Disputer can't be 0");
        Assertion storage assertion = _assertions[assertionId];
        require(assertion.asserter != address(0), "Assertion does not exist");
        require(assertion.disputer == address(0), "Assertion already disputed");
        require(assertion.expirationTime > block.timestamp, "Assertion is expired");
        assertion.disputer = disputer;
        assertion.currency.safeTransferFrom(msg.sender, address(this), assertion.bond);
        if (assertion.callbackRecipient != address(0)) {
            IOptimisticOracleV3CallbackRecipient(assertion.callbackRecipient).assertionDisputedCallback(assertionId);
        }
        emit AssertionDisputed(assertionId, msg.sender, disputer);
    }

    function simulateDvmResolution(bytes32 assertionId, bool assertedTruthfully) external {
        require(msg.sender == admin, "mock: admin only");
        require(_assertions[assertionId].disputer != address(0), "mock: not disputed");
        hasSimulatedResolution[assertionId] = true;
        simulatedResolution[assertionId] = assertedTruthfully;
        emit SimulatedDvmResolution(assertionId, assertedTruthfully);
    }

    function settleAssertion(bytes32 assertionId) external nonReentrant {
        Assertion storage assertion = _assertions[assertionId];
        require(assertion.asserter != address(0), "Assertion does not exist");
        require(!assertion.settled, "Assertion already settled");
        assertion.settled = true;
        if (assertion.disputer == address(0)) {
            require(assertion.expirationTime <= block.timestamp, "Assertion not expired");
            assertion.settlementResolution = true;
            assertion.currency.safeTransfer(assertion.asserter, assertion.bond);
            _callbackOnResolve(assertion.callbackRecipient, assertionId, true);
            emit AssertionSettled(assertionId, assertion.asserter, false, true, msg.sender);
        } else {
            require(hasSimulatedResolution[assertionId], "mock: dispute not resolved (no DVM answer)");
            bool truthful = simulatedResolution[assertionId];
            assertion.settlementResolution = truthful;
            address bondRecipient = truthful ? assertion.asserter : assertion.disputer;
            uint256 oracleFee = (BURNED_BOND_PERCENTAGE * assertion.bond) / 1e18;
            assertion.currency.safeTransfer(store, oracleFee);
            assertion.currency.safeTransfer(bondRecipient, assertion.bond * 2 - oracleFee);
            _callbackOnResolve(assertion.callbackRecipient, assertionId, truthful);
            emit AssertionSettled(assertionId, bondRecipient, true, truthful, msg.sender);
        }
    }

    function _callbackOnResolve(address recipient, bytes32 assertionId, bool truthful) private {
        if (recipient != address(0)) {
            IOptimisticOracleV3CallbackRecipient(recipient).assertionResolvedCallback(assertionId, truthful);
        }
    }
}
