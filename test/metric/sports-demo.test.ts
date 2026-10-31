import { describe, expect, it } from "vitest";
import {
  normalizeSportsDemo,
  parseSportsDemoForMetric,
  type SportsDemoInput,
  type SportsMetricTarget,
} from "../../src/metric/sports-demo.js";
import { parseFixed100 } from "../../src/metric/fixed100.js";
import { readFileSync } from "node:fs";
import {
  decodeUtf8,
  parseJsonStrict,
} from "../../src/weather/strict.js";

const basketball: SportsDemoInput = {
  schema: "RAINPOOL_SPORTS_DEMO_V1",
  synthetic: true,
  matchId: "LAL_BOS_DEMO01",
  teamA: "LAL",
  teamB: "BOS",
  status: "FINAL",
  scoreA: 108,
  scoreB: 101,
  sport: "BASKETBALL",
  scoreScope: "INCLUDING_OVERTIME",
};

describe("sports demo normalization", () => {
  it.each([
    [108, 101, "7"],
    [101, 108, "-7"],
  ] as const)(
    "converts basketball %i:%i into margin %s",
    (scoreA, scoreB, valueText) => {
      const result = normalizeSportsDemo({
        ...basketball,
        scoreA,
        scoreB,
      });

      expect(result).toEqual({
        metricCode: "SCORE_MARGIN",
        unit: "points",
        sourceId: "DEMO_BASKETBALL",
        subjectId: "LAL_BOS_DEMO01",
        valueText,
        teamA: "LAL",
        teamB: "BOS",
        scoreScope: "INCLUDING_OVERTIME",
      });
    }
  );

  it("represents a football draw as zero", () => {
    const result = normalizeSportsDemo({
      ...basketball,
      matchId: "ARS_CHE_DEMO01",
      teamA: "ARS",
      teamB: "CHE",
      sport: "FOOTBALL",
      scoreScope: "REGULATION_90",
      scoreA: 1,
      scoreB: 1,
    });

    expect(result).toEqual({
      metricCode: "GOAL_MARGIN",
      unit: "goals",
      sourceId: "DEMO_FOOTBALL",
      subjectId: "ARS_CHE_DEMO01",
      valueText: "0",
      teamA: "ARS",
      teamB: "CHE",
      scoreScope: "REGULATION_90",
    });
  });

  it("scales a normalized margin once for the numeric reading", () => {
    const normalized = normalizeSportsDemo(basketball);
    expect(normalized.valueText).toBe("7");
    expect(parseFixed100(normalized.valueText)).toBe(700);
  });

  describe("sports demo validation and boundaries", () => {
    const invalidInputs: Array<[string, unknown, RegExp]> = [
        ["null", null, /object/],
        ["array", [], /object/],
        ["unparsed JSON", JSON.stringify(basketball), /object/],

        ["wrong schema", { ...basketball, schema: "OTHER" }, /schema/],
        ["real-data flag", { ...basketball, synthetic: false }, /synthetic/],
        ["string flag", { ...basketball, synthetic: "true" }, /synthetic/],
        ["unfinished match", { ...basketball, status: "LIVE" }, /FINAL/],

        ["unsupported sport", { ...basketball, sport: "TENNIS" }, /sport/],
        [
        "wrong basketball scope",
        { ...basketball, scoreScope: "REGULATION_90" },
        /scoreScope/,
        ],
        [
        "wrong football scope",
        { ...basketball, sport: "FOOTBALL" },
        /scoreScope/,
        ],

        ["blank team", { ...basketball, teamA: "   " }, /teamA/],
        ["same teams", { ...basketball, teamB: " LAL " }, /different/],
        ["blank match ID", { ...basketball, matchId: "" }, /matchId/],
        [
        "match ID exceeding byte limit",
        { ...basketball, matchId: "中".repeat(11) },
        /matchId/,
        ],
        [
        "match ID containing zero byte",
        { ...basketball, matchId: "GAME\0ONE" },
        /zero byte/,
        ],

        ["string score", { ...basketball, scoreA: "108" }, /scoreA/],
        ["fractional score", { ...basketball, scoreA: 108.5 }, /scoreA/],
        ["negative score", { ...basketball, scoreA: -1 }, /scoreA/],
        ["missing score", { ...basketball, scoreB: undefined }, /scoreB/],
        [
        "unsafe integer scores",
        {
            ...basketball,
            scoreA: Number.MAX_SAFE_INTEGER + 1,
            scoreB: Number.MAX_SAFE_INTEGER + 1,
        },
        /scoreA/,
        ],
    ];

    it.each(invalidInputs)("rejects %s", (_name, input, error) => {
        expect(() => normalizeSportsDemo(input)).toThrow(error);
    });

    it("trims identifiers and team names consistently", () => {
        const result = normalizeSportsDemo({
        ...basketball,
        matchId: " LAL_BOS_DEMO01 ",
        teamA: " LAL ",
        teamB: " BOS ",
        });

        expect(result).toMatchObject({
        subjectId: "LAL_BOS_DEMO01",
        teamA: "LAL",
        teamB: "BOS",
        });
    });

    it.each([
        "A".repeat(31),
        "中".repeat(10) + "A",
    ])("accepts a match ID occupying exactly 31 bytes: %s", (matchId) => {
        expect(
        normalizeSportsDemo({ ...basketball, matchId }).subjectId
        ).toBe(matchId);
    });

    it.each([
        [21474836, 0, "21474836"],
        [0, 21474836, "-21474836"],
    ] as const)(
        "accepts a representable margin from %i:%i",
        (scoreA, scoreB, expected) => {
        const result = normalizeSportsDemo({
            ...basketball,
            scoreA,
            scoreB,
        });

        expect(result.valueText).toBe(expected);
        }
    );

    it.each([
        [21474837, 0],
        [0, 21474837],
    ] as const)(
        "rejects an overflowing margin from %i:%i",
        (scoreA, scoreB) => {
        expect(() =>
            normalizeSportsDemo({ ...basketball, scoreA, scoreB })
        ).toThrow(/outside int32/);
        }
    );
  });


  describe("sports demo files", () => {
    it.each([
        [
        "basketball-lal-bos.json",
        "SCORE_MARGIN", "points",
        "DEMO_BASKETBALL", "LAL_BOS_DEMO01", "7",
        ],
        [
        "football-ars-che.json",
        "GOAL_MARGIN", "goals",
        "DEMO_FOOTBALL", "ARS_CHE_DEMO01", "1",
        ],
        [
        "football-ars-che-draw.json",
        "GOAL_MARGIN", "goals",
        "DEMO_FOOTBALL", "ARS_CHE_DEMO02", "0",
        ],
    ] as const)(
        "normalizes the identities and unscaled margin in %s",
        (filename, metricCode, unit, sourceId, subjectId, valueText) => {
        const fileUrl = new URL(
            `../../fixtures/demo/sports/${filename}`,
            import.meta.url
        );

        const bytes = readFileSync(fileUrl);
        const input = parseJsonStrict(decodeUtf8(bytes));
        const normalized = normalizeSportsDemo(input);

        expect(normalized).toMatchObject({
            metricCode,
            unit,
            sourceId,
            subjectId,
            valueText,
        });

        expect(parseFixed100(normalized.valueText)).toBe(Number(valueText) * 100);
        }
    );
  });


  describe("sports demo and selected metric", () => {
    const scoreMetric: SportsMetricTarget = {
        code: "SCORE_MARGIN",
        unit: "points",
        minValue: -50000,
        maxValue: 50000,
        valueStep: 100,
    };

    it("accepts a matching metric and keeps the unscaled value", () => {
        const result = parseSportsDemoForMetric(
        JSON.stringify(basketball),
        scoreMetric
        );

        expect(result).toMatchObject({
        metricCode: "SCORE_MARGIN",
        unit: "points",
        valueText: "7",
        });
    });

    it.each([
        ["wrong metric", { code: "GOAL_MARGIN" }, /metric or unit/],
        ["wrong unit", { unit: "goals" }, /metric or unit/],
        ["above maximum", { maxValue: 600 }, /outside metric range/],
        ["below minimum", { minValue: 800 }, /outside metric range/],
        ["invalid step", { valueStep: 200 }, /metric step/],
    ] as const)(
        "rejects %s",
        (_name, override, error) => {
        expect(() =>
            parseSportsDemoForMetric(
            JSON.stringify(basketball),
            { ...scoreMetric, ...override }
            )
        ).toThrow(error);
        }
    );

    it("rejects duplicate JSON fields before normalization", () => {
        const text = JSON.stringify(basketball).replace(
        '"scoreA":108',
        '"scoreA":108,"scoreA":109'
        );

        expect(() =>
        parseSportsDemoForMetric(text, scoreMetric)
        ).toThrow(/duplicate JSON key/);
    });
  });
});
