// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;


import {
    MetricDefinition,
    MetricReading,
    ReadingKind
} from "./MarketTypes.sol";


library MetricReadingLib {
    error InvalidReadingKind();
    error InvalidMetricStep();
    error ReadingOutOfRange();
    error ReadingStepMismatch();
    error TraceNotAllowed();
    error InvalidTraceValue();


    function validate(
        MetricDefinition memory definition,
        MetricReading memory reading
    ) internal pure {
        // 普通数值：检查范围和步长
        if (reading.kind == ReadingKind.NUMERIC) {
            if (
                reading.value < definition.minValue ||
                reading.value > definition.maxValue
            ) {
                revert ReadingOutOfRange();
            }

            if (definition.valueStep == 0) {
                revert InvalidMetricStep();
            }

            int256 value = int256(reading.value);
            int256 step = int256(uint256(definition.valueStep));

            if (value % step != 0) {
                revert ReadingStepMismatch();
            }

            return;
        }

        // Trace：雨量问题特殊处理
        if (reading.kind == ReadingKind.TRACE) {
            if (!definition.allowsTrace) {
                revert TraceNotAllowed();
            }

            if (reading.value != 0) {
                revert InvalidTraceValue();
            }

            return;
        }

        // NONE 不是有效读数
        revert InvalidReadingKind();
    }
}