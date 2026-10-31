// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMarketOracleAdapter {
    function market() external view returns (address);
}