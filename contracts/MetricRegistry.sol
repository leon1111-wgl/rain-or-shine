// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MetricDefinition} from "./MarketTypes.sol";
import {ConditionLib} from "./ConditionLib.sol";


/**
 * A registry for managing metric definitions.
 */
abstract contract MetricRegistry {
    // 有权注册新指标的管理员
    address public immutable metricAdmin;

    // 已注册指标数量；编号从 1 开始
    uint32 public metricCount;

    // 指标编号 -> 完整定义
    mapping(uint32 => MetricDefinition) private _metricDefinitions;

    // 指标代码 -> 指标编号；0 表示未注册
    mapping(bytes32 => uint32) public metricIdByCode;

    error InvalidMetricAdmin();
    error OnlyMetricAdmin();
    error InvalidMetricDefinition();
    error DuplicateMetricCode(bytes32 code);
    error UnknownMetric(uint32 metricId);

    event MetricRegistered(
        uint32 indexed metricId,
        bytes32 indexed code,
        bytes32 rulesHash
    );

    constructor(address initialMetricAdmin) {
        if (initialMetricAdmin == address(0)) {
            revert InvalidMetricAdmin();
        }

        metricAdmin = initialMetricAdmin;
    }

    modifier onlyMetricAdmin() {
        if (msg.sender != metricAdmin) {
            revert OnlyMetricAdmin();
        }

        _;
    }


    function registerMetric(
        MetricDefinition calldata definition
    ) external onlyMetricAdmin returns (uint32 metricId) {
        // 基本字段不能为空
        if (
            definition.code == bytes32(0) ||
            definition.unit == bytes32(0) ||
            definition.rulesHash == bytes32(0)
        ) {
            revert InvalidMetricDefinition();
        }

        // 相同代码不能重复注册
        if (metricIdByCode[definition.code] != 0) {
            revert DuplicateMetricCode(definition.code);
        }

        // 检查数值范围和读数步长
        if (
            definition.minValue > definition.maxValue ||
            definition.valueStep == 0
        ) {
            revert InvalidMetricDefinition();
        }

        // 确保范围内至少存在一个符合步长的数值
        int256 minimum = int256(definition.minValue);
        int256 step = int256(uint256(definition.valueStep));

        int256 firstValidValue = (minimum / step) * step;

        if (firstValidValue < minimum) {
            firstValidValue += step;
        }

        if (firstValidValue > int256(definition.maxValue)) {
            revert InvalidMetricDefinition();
        }

        // 允许 TRACE 时必须满足 ConditionLib 的 TRACE 前提，否则 TRACE 读数永远无法提交
        if (
            definition.allowsTrace &&
            !ConditionLib.supportsTrace(definition)
        ) {
            revert InvalidMetricDefinition();
        }

        // 分配编号并永久保存定义
        metricId = ++metricCount;

        _metricDefinitions[metricId] = definition;
        metricIdByCode[definition.code] = metricId;

        emit MetricRegistered(
            metricId,
            definition.code,
            definition.rulesHash
        );
    }

    function getMetric(
        uint32 metricId
    ) public view returns (MetricDefinition memory) {
        if (metricId == 0 || metricId > metricCount) {
            revert UnknownMetric(metricId);
        }

        return _metricDefinitions[metricId];
    }
}