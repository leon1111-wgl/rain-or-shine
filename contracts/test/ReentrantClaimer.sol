// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReentryMarket {
    function bet(uint256 marketId, uint8 side) external payable;

    function claim(uint256 marketId) external returns (uint256);
}

interface IReentryAdapter {
    function settle(bytes32 assertionId) external;
}

// Test-only bettor that tries to reenter while claim() sends it ETH.
contract ReentrantClaimer {
    enum Mode {
        NONE,
        CLAIM_AGAIN,
        SETTLE_OTHER,
        CLAIM_AGAIN_CAUGHT
    }

    IReentryMarket public immutable market;
    IReentryAdapter public immutable adapter;

    uint256 public marketId;
    Mode public mode;
    bytes32 public otherAssertion;
    bool public reentryFailed;

    constructor(IReentryMarket market_, IReentryAdapter adapter_) {
        market = market_;
        adapter = adapter_;
    }

    function placeBet(uint256 id, uint8 side) external payable {
        marketId = id;
        market.bet{value: msg.value}(id, side);
    }

    function attack(Mode mode_, bytes32 other) external {
        mode = mode_;
        otherAssertion = other;
        market.claim(marketId);
    }

    receive() external payable {
        if (mode == Mode.CLAIM_AGAIN) {
            market.claim(marketId);
        } else if (mode == Mode.SETTLE_OTHER) {
            adapter.settle(otherAssertion);
        } else if (mode == Mode.CLAIM_AGAIN_CAUGHT) {
            try market.claim(marketId) {
                reentryFailed = false;
            } catch {
                reentryFailed = true;
            }
        }
    }
}
