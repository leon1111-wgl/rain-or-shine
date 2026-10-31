import { encodeBytes32String } from "ethers";
import { parseFixed100 } from "./fixed100.js";
import { parseJsonStrict } from "../weather/strict.js";

export type SportsDemoInput = {
    schema: "RAINPOOL_SPORTS_DEMO_V1";
    synthetic: true;
    matchId: string;
    teamA: string;
    teamB: string;
    status: "FINAL";
    scoreA: number;
    scoreB: number;
} & (
    | { sport: "BASKETBALL"; scoreScope: "INCLUDING_OVERTIME" }
    | { sport: "FOOTBALL"; scoreScope: "REGULATION_90" }
);


function readSportsDemoObject(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new Error("sports demo input must be an object");
  }

  const data = input as Record<string, unknown>;

  if (data.schema !== "RAINPOOL_SPORTS_DEMO_V1") {
    throw new Error("unsupported sports demo schema");
  }

  if (data.synthetic !== true) {
    throw new Error("sports demo must declare synthetic=true");
  }

  if (data.status !== "FINAL") {
    throw new Error("sports demo requires a FINAL result");
  }

  return data;
}


function readNonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be non-empty text`);
  }

  return value.trim();
}

function readMatchId(value: unknown): string {
  const matchId = readNonEmptyText(value, "matchId");

  if (matchId.includes("\0")) {
    throw new Error("matchId must not contain a zero byte");
  }

  try {
    encodeBytes32String(matchId);
  } catch {
    throw new Error(
      "matchId must be valid text within 31 UTF-8 bytes"
    );
  }

  return matchId;
}


function readScore(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }

  return value;
}


function readSportsDemoFields(input: unknown) {
  const data = readSportsDemoObject(input);

  const matchId = readMatchId(data.matchId);
  const teamA = readNonEmptyText(data.teamA, "teamA");
  const teamB = readNonEmptyText(data.teamB, "teamB");

  if (teamA === teamB) {
    throw new Error("teamA and teamB must be different");
  }

  const scoreA = readScore(data.scoreA, "scoreA");
  const scoreB = readScore(data.scoreB, "scoreB");

  return {
    matchId,
    teamA,
    teamB,
    scoreA,
    scoreB,
    sport: data.sport,
    scoreScope: data.scoreScope,
  };
}


export type NormalizedSportsDemo = {
  subjectId: string;
  valueText: string;
  teamA: string;
  teamB: string;
} & (
  | {
      metricCode: "SCORE_MARGIN";
      unit: "points";
      sourceId: "DEMO_BASKETBALL";
      scoreScope: "INCLUDING_OVERTIME";
    }
  | {
      metricCode: "GOAL_MARGIN";
      unit: "goals";
      sourceId: "DEMO_FOOTBALL";
      scoreScope: "REGULATION_90";
    }
);


export function normalizeSportsDemo(
  input: unknown
): NormalizedSportsDemo {
  const fields = readSportsDemoFields(input);

  const isBasketball =
    fields.sport === "BASKETBALL" &&
    fields.scoreScope === "INCLUDING_OVERTIME";

  const isFootball =
    fields.sport === "FOOTBALL" &&
    fields.scoreScope === "REGULATION_90";

  if (!isBasketball && !isFootball) {
    throw new Error("unsupported sport or scoreScope");
  }

  const valueText = String(fields.scoreA - fields.scoreB);

  parseFixed100(valueText);

  const common = {
    subjectId: fields.matchId,
    valueText,
    teamA: fields.teamA,
    teamB: fields.teamB,
  };

  if (isBasketball) {
    return {
      ...common,
      metricCode: "SCORE_MARGIN",
      unit: "points",
      sourceId: "DEMO_BASKETBALL",
      scoreScope: "INCLUDING_OVERTIME",
    };
  }

  return {
    ...common,
    metricCode: "GOAL_MARGIN",
    unit: "goals",
    sourceId: "DEMO_FOOTBALL",
    scoreScope: "REGULATION_90",
  };
}


export interface SportsMetricTarget {
  code: string;
  unit: string;

  minValue: number;
  maxValue: number;
  valueStep: number;
}


export function parseSportsDemoForMetric(
  text: string,
  metric: SportsMetricTarget
): NormalizedSportsDemo {
  const normalized = normalizeSportsDemo(parseJsonStrict(text));

  if (
    normalized.metricCode !== metric.code ||
    normalized.unit !== metric.unit
  ) {
    throw new Error(
      "imported sports metric or unit does not match selected metric"
    );
  }

  const scaledValue = parseFixed100(normalized.valueText);

  if (
    scaledValue < metric.minValue ||
    scaledValue > metric.maxValue
  ) {
    throw new Error("imported sports reading is outside metric range");
  }

  if (scaledValue % metric.valueStep !== 0) {
    throw new Error("imported sports reading does not match metric step");
  }

  return normalized;
}
