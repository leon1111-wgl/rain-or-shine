// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;


import {
    Comparison,
    Condition,
    MetricDefinition,
    MetricReading,
    ReadingKind
} from "./MarketTypes.sol";

import {MetricReadingLib} from "./MetricReadingLib.sol";


library ConditionLib {
    enum ConditionValidationResult {
        INDETERMINATE,
        YES,
        NO
    }


    error InvalidCondition();
    error NumericReadingRequired();
    error UnsupportedTraceDefinition();
    error ThresholdOutOfRange();
    error ThresholdStepMismatch();
    error IndeterminateTraceCondition();

    // trace 的上限值
    int32 private constant TRACE_UPPER = 5;

    // TRACE 表示 0 < 雨量 < 0.05 mm；指标范围必须覆盖这个区间。
    function supportsTrace(
        MetricDefinition memory definition
    ) internal pure returns (bool) {
        return
            definition.unit == bytes32("mm") &&
            definition.minValue <= 0 &&
            definition.maxValue >= TRACE_UPPER;
    }

    // 创建市场时使用：阈值必须是该指标能报告的值；
    // 允许 TRACE 的指标还必须能由 TRACE 读数判定结果。
    function validateForMetric(
        MetricDefinition memory definition,
        Condition memory condition
    ) internal pure {
        validateCondition(condition);
        _requireReportable(definition, condition.lower);

        if (condition.comparison == Comparison.RANGE) {
            _requireReportable(definition, condition.upper);
        }

        if (
            definition.allowsTrace &&
            _traceResult(definition, condition) ==
                ConditionValidationResult.INDETERMINATE
        ) {
            revert IndeterminateTraceCondition();
        }
    }

    function _requireReportable(
        MetricDefinition memory definition,
        int32 threshold
    ) private pure {
        if (
            threshold < definition.minValue ||
            threshold > definition.maxValue
        ) {
            revert ThresholdOutOfRange();
        }

        int256 step = int256(uint256(definition.valueStep));

        if (int256(threshold) % step != 0) {
            revert ThresholdStepMismatch();
        }
    }

    function validateCondition(
        Condition memory condition
    ) internal pure {
        if (
            condition.metricId == 0 ||
            condition.comparison == Comparison.NONE
        ) {
            revert InvalidCondition();
        }

        if (condition.comparison == Comparison.RANGE) {
            if (condition.lower > condition.upper) {
                revert InvalidCondition();
            }
        } else if (condition.upper != 0) {
            revert InvalidCondition();
        }
    }

    function evaluateNumeric(
        MetricDefinition memory definition,
        Condition memory condition,
        MetricReading memory reading
    ) internal pure returns (ConditionValidationResult) {
        validateCondition(condition);

        if (reading.kind != ReadingKind.NUMERIC) {
            revert NumericReadingRequired();
        }

        MetricReadingLib.validate(definition, reading);

        int32 value = reading.value;
        Comparison comparison = condition.comparison;
        bool satisfied;

        if (comparison == Comparison.LT) {
            satisfied = value < condition.lower;
        } else if (comparison == Comparison.LTE) {
            satisfied = value <= condition.lower;
        } else if (comparison == Comparison.GT) {
            satisfied = value > condition.lower;
        } else if (comparison == Comparison.GTE) {
            satisfied = value >= condition.lower;
        } else if (comparison == Comparison.RANGE) {
            satisfied =
                value >= condition.lower &&
                value <= condition.upper;
        } else {
            revert InvalidCondition();
        }

        return satisfied ? ConditionValidationResult.YES : ConditionValidationResult.NO;
    }


    function evaluate(
        MetricDefinition memory definition,
        Condition memory condition,
        MetricReading memory reading
    ) internal pure returns (ConditionValidationResult) {
        if (reading.kind == ReadingKind.NUMERIC) {
            return evaluateNumeric(definition, condition, reading);
        }

        validateCondition(condition);
        MetricReadingLib.validate(definition, reading);

        // 校验通过后，此分支只能是 TRACE。
        return _traceResult(definition, condition);
    }

    // 创建市场与评估读数共用这一判定，两者不会不一致。
    function _traceResult(
        MetricDefinition memory definition,
        Condition memory condition
    ) private pure returns (ConditionValidationResult) {
        // 注册表已保证允许 TRACE 的指标满足此条件；这里仍做防御性检查。
        if (!supportsTrace(definition)) {
            revert UnsupportedTraceDefinition();
        }

        return _evaluateTrace(condition);
    }

    function _evaluateTrace(
        Condition memory condition
    ) private pure returns (ConditionValidationResult) {
        Comparison comparison = condition.comparison;
        int32 threshold = condition.lower;

        if (
            comparison == Comparison.GT ||
            comparison == Comparison.GTE
        ) {
            if (threshold <= 0) {
                return ConditionValidationResult.YES;
            }
            if (threshold >= TRACE_UPPER) {
                return ConditionValidationResult.NO;
            }
            return ConditionValidationResult.INDETERMINATE;
        }

        if (
            comparison == Comparison.LT ||
            comparison == Comparison.LTE
        ) {
            if (threshold <= 0) {
                return ConditionValidationResult.NO;
            }
            if (threshold >= TRACE_UPPER) {
                return ConditionValidationResult.YES;
            }
            return ConditionValidationResult.INDETERMINATE;
        }

        if (comparison == Comparison.RANGE) {
            if (
                condition.upper <= 0 ||
                condition.lower >= TRACE_UPPER
            ) {
                return ConditionValidationResult.NO;
            }
            if (
                condition.lower <= 0 &&
                condition.upper >= TRACE_UPPER
            ) {
                return ConditionValidationResult.YES;
            }
            return ConditionValidationResult.INDETERMINATE;
        }

        revert InvalidCondition();
    }
}