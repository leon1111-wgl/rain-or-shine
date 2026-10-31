// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// 用户下注方向
enum Side {
    NONE,
    YES,
    NO
}

// 市场结算状态
enum Terminal {
    UNRESOLVED,
    YES,
    NO,
    REFUND
}

// 退款原因
enum RefundReason {
    NONE,
    EMPTY,
    SINGLE_SIDED,
    NO_VALID_SETTLEMENT
}

// 观察值类型
enum ReadingKind {
    NONE,
    NUMERIC,
    TRACE
}

// 领取款项的类型
enum ClaimType {
    WINNINGS,
    REFUND
}

// 预言机结果回调的处理结果
enum OracleOutcome {
    ACCEPTED,
    REJECTED,
    IGNORED_LATE,
    IGNORED_DUPLICATE
}

// 数值比较方式；RANGE 表示包含上下界的区间
enum Comparison {
    NONE,
    LT,
    LTE,
    GT,
    GTE,
    RANGE
}

// 指标定义：数值及步长均使用实际值 × 100 的编码
struct MetricDefinition {
    bytes32 code;
    bytes32 unit;

    int32 minValue;
    int32 maxValue;
    uint32 valueStep;

    bool allowsTrace;
    bytes32 rulesHash;
}

// 一个市场需要判断的条件
struct Condition {
    uint32 metricId;
    Comparison comparison;

    int32 lower;
    int32 upper;
}

// 市场时间配置：时间点为 Unix 秒，assertionLiveness 为持续秒数
struct PoolTimes {
    uint64 openAt;
    uint64 closeAt;

    uint64 observationStart;
    uint64 observationEnd;

    uint64 earliestAssertionAt;
    uint64 proposalCutoff;
    uint64 refundAt;
    uint64 assertionLiveness;
}

// 创建市场时固定的配置，不包含未来的观察结果
struct MarketConfig {
    address proposer;

    bytes32 sourceId;
    bytes32 subjectId;

    Condition condition;
    PoolTimes times;
}

// 市场资金与结算状态；资金单位为 wei
struct MarketState {
    uint256 yesTotal;
    uint256 noTotal;
    uint256 paidOut;

    uint32 yesAccounts;
    uint32 noAccounts;

    Terminal terminal;
    RefundReason refundReason;
}

// 链下处理后提交的标准读数
struct MetricReading {
    ReadingKind kind;

    // NUMERIC：实际值 × 100，支持负数
    // TRACE：固定填 0，作为占位值，不代表精确的零降雨
    int32 value;
}

// 一个用户在一个市场中的下注记录
struct Position {
    Side side;
    bool claimed;
    uint256 stake;
}

// 一个市场的观察值断言记录
struct MarketAssertionRecord {
    bytes32 assertionId;
    MetricReading reading;

    // 提交观察结果时承诺的原始数据哈希
    bytes32 rawSha256;
    uint64 proposedAt;

    bool disputed;
    bool returned;
    bool rejected;
}