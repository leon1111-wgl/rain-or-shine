// The metric registry table. Metrics are registered by the new-market flow (create-market.test.tsx).
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customMetricRulesDocument } from "../../src/metric/custom-profile";
import { NUMERIC_METRIC_PRESETS } from "../../src/metric/numeric-profiles";
import type { MetricView } from "../../web/src/metric/client";
import type { useMetricApp } from "../../web/src/metric/context";
import { Registry } from "../../web/src/metric/forms";

const weeklyRain = customMetricRulesDocument({
  code: "WEEKLY_RAINFALL", unit: "mm", minValue: 0, maxValue: 999_990, valueStep: 10, allowsTrace: false,
  interpretation: "Total rainfall at HKO headquarters over the market observation window, in mm.",
});

type MetricApi = ReturnType<typeof useMetricApp>;
const mocks = vi.hoisted(() => ({ useMetricApp: vi.fn<() => MetricApi>() }));
vi.mock("../../web/src/metric/context", () => ({ useMetricApp: mocks.useMetricApp }));

const fromPreset = (code: string, id: number): MetricView => ({ ...NUMERIC_METRIC_PRESETS.find((item) => item.code === code)!, id });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.useMetricApp.mockReturnValue({
    data: { now: 1_800_000_000, metrics: [{ id: 1, ...weeklyRain.definition, rulesHash: weeklyRain.rulesHash }, fromPreset("TOTAL_RAINFALL", 2), fromPreset("DAILY_MAX_TEMPERATURE", 3)] },
  } as unknown as MetricApi);
});

describe("metric registry", () => {
  it("lists the two official metrics first and labels every metric", () => {
    render(<Registry />);
    expect(screen.getAllByTestId(/^metric-row-/).map((row) => row.getAttribute("data-testid"))).toEqual([
      "metric-row-TOTAL_RAINFALL", "metric-row-DAILY_MAX_TEMPERATURE", "metric-row-WEEKLY_RAINFALL",
    ]);
    expect(within(screen.getByTestId("metric-row-TOTAL_RAINFALL")).getByText("Official")).toBeVisible();
    expect(within(screen.getByTestId("metric-row-WEEKLY_RAINFALL")).getByText("Custom")).toBeVisible();
    expect(screen.getByTestId("metric-row-WEEKLY_RAINFALL")).toHaveTextContent("0.0 to 9999.9 mm");
  });

  it("labels a sports demo metric as a demo", () => {
    mocks.useMetricApp.mockReturnValue({ data: { now: 1_800_000_000, metrics: [fromPreset("SCORE_MARGIN", 4), fromPreset("TOTAL_RAINFALL", 2)] } } as unknown as MetricApi);
    render(<Registry />);
    expect(within(screen.getByTestId("metric-row-SCORE_MARGIN")).getByText("Demo")).toBeVisible();
  });
});
