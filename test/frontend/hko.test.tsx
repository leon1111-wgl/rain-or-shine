// The live HKO panel shows official readings with HKO's own times and the page's read time. It is display only.
// Reads go through the page's own server. A static host has no relay, so the page then reads HKO directly.
// A failing, missing or maintenance value is shown as such, never as a number.
// A stubbed fetch serves the real captures in fixtures/official/hko-open-data (2026-10-04 08:15 HKT).
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWeatherUrl, hourlyRainfallUrl } from "../../src/weather/live";
import { ryesUrl } from "../../src/weather/profile";
import { HkoLivePanel } from "../../web/src/components/HkoLivePanel";
import { setActiveLocale } from "../../web/src/i18n";
import { clearHkoCache, loadHkoLive, viaPageServer } from "../../web/src/lib/hko";

const DIR = "fixtures/official/hko-open-data";
const CAPTURED_AT = Date.parse("2026-10-04T08:15:56+08:00");

function captured(feed: string, lang: string): string {
  const file = readdirSync(DIR).find((f) => f.startsWith(`${feed}_${lang}_`) && !f.endsWith(".meta.json"));
  if (!file) throw new Error(`no ${feed} ${lang} capture`);
  return readFileSync(path.join(DIR, file), "utf8");
}

const json = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const PATHS = (lang: "sc" | "en") => ({
  current: viaPageServer(currentWeatherUrl(lang)),
  hourly: viaPageServer(hourlyRainfallUrl(lang)),
  yesterday: viaPageServer(ryesUrl("20261003", lang)),
});

/** Answers the page's relay paths with the real captures; `override` replaces the answer for one path. */
function hkoFetch(lang: "sc" | "en" = "sc", override: Record<string, () => Promise<Response>> = {}) {
  const p = PATHS(lang);
  const routes: Record<string, string> = { [p.current]: captured("rhrread", lang), [p.hourly]: captured("hourlyRainfall", lang), [p.yesterday]: captured("RYES-20261003", lang) };
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const replaced = override[url];
    if (replaced) return replaced();
    const body = routes[url];
    return body === undefined ? new Response("not an allowed HKO open-data read\n", { status: 404 }) : json(body);
  });
}

function edited(feed: string, change: (doc: Record<string, unknown>) => void): () => Promise<Response> {
  const doc = JSON.parse(captured(feed, "sc")) as Record<string, unknown>;
  change(doc);
  return async () => json(JSON.stringify(doc));
}

beforeEach(() => {
  clearHkoCache();
  setActiveLocale("zh-CN"); // the captures below are mostly the Chinese feeds
  vi.useFakeTimers({ now: CAPTURED_AT, toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setActiveLocale("en");
});

describe("live HKO reads (web/src/lib/hko.ts)", () => {
  it("reads the three official feeds through the page's server, uncached, and yesterday's report once per date", async () => {
    const fetchImpl = hkoFetch();
    const first = await loadHkoLive("sc", fetchImpl, () => CAPTURED_AT);
    expect(first.readAt).toBe(CAPTURED_AT / 1000);
    expect(first.current.ok && first.current.value.temperature?.value).toBe(27);
    expect(first.hourly.ok && first.hourly.value?.mm).toBe(0);
    expect(first.yesterday.ok && first.yesterday.value.rainfall.text).toBe("44.1");
    const p = PATHS("sc");
    expect(fetchImpl.mock.calls.map((c) => String(c[0])).sort()).toEqual([p.current, p.hourly, p.yesterday].sort());
    for (const call of fetchImpl.mock.calls) expect(call[1]?.cache).toBe("no-store");
    await loadHkoLive("sc", fetchImpl, () => CAPTURED_AT + 60_000);
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]) === p.yesterday)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("reports one failing feed on its own and fails only when all three fail", async () => {
    const p = PATHS("sc");
    const fetchImpl = hkoFetch("sc", { [p.hourly]: async () => new Response("HKO answered HTTP 503\n", { status: 502 }) });
    const partial = await loadHkoLive("sc", fetchImpl, () => CAPTURED_AT);
    expect(partial.hourly).toEqual({ ok: false, error: "HTTP 502" });
    expect(partial.current.ok && partial.yesterday.ok).toBe(true);
    // The relay answered, so its error stands. The page does not go around it.
    expect(fetchImpl.mock.calls.map((c) => String(c[0])).filter((url) => url.startsWith("https://"))).toEqual([]);
    clearHkoCache();
    const down = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadHkoLive("sc", down, () => CAPTURED_AT)).rejects.toThrow("Failed to fetch");
  });

  it("on a static host with no relay it reads HKO's open-data host directly", async () => {
    const p = PATHS("sc");
    const direct = { current: currentWeatherUrl("sc"), hourly: hourlyRainfallUrl("sc"), yesterday: ryesUrl("20261003", "sc") };
    const routes: Record<string, string> = {
      [direct.current]: captured("rhrread", "sc"), [direct.hourly]: captured("hourlyRainfall", "sc"), [direct.yesterday]: captured("RYES-20261003", "sc"),
    };
    // GitHub Pages answers a missing path with 404. Other hosts may serve the app page with 200.
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === p.current) return new Response("<!doctype html><title>Rain or Shine</title>", { status: 200, headers: { "content-type": "text/html" } });
      if (url === p.hourly || url === p.yesterday) return new Response("Not Found", { status: 404 });
      const body = routes[url];
      return body === undefined ? new Response("Not Found", { status: 404 }) : json(body);
    });
    const live = await loadHkoLive("sc", fetchImpl, () => CAPTURED_AT);
    expect(live.current.ok && live.current.value.temperature?.value).toBe(27);
    expect(live.hourly.ok && live.hourly.value?.mm).toBe(0);
    expect(live.yesterday.ok && live.yesterday.value.rainfall.text).toBe("44.1");
    expect(fetchImpl.mock.calls.map((c) => String(c[0])).sort()).toEqual([...Object.values(direct), p.current, p.hourly, p.yesterday].sort());
    for (const call of fetchImpl.mock.calls) expect(call[1]?.cache).toBe("no-store");
  });
});

describe("live HKO panel", () => {
  it("shows the Observatory's readings with HKO's times, the read time and the official page", async () => {
    vi.stubGlobal("fetch", hkoFetch());
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-temperature")).toHaveTextContent("气温27 °C08:00");
    expect(screen.getByTestId("hko-humidity")).toHaveTextContent("相对湿度91 %08:00");
    expect(screen.getByTestId("hko-hour")).toHaveTextContent("1 小时雨量 *0 mm至 08:00");
    expect(screen.getByTestId("hko-yesterday")).toHaveTextContent("昨日总雨量44.1 mm10-03 全日");
    expect(screen.getByTestId("hko-times")).toHaveTextContent("发布 08:02");
    expect(screen.getByTestId("hko-times")).toHaveTextContent("读取 08:15:56");
    expect(screen.getByRole("link", { name: /官网核对/ })).toHaveAttribute("href", "https://www.hko.gov.hk/sc/wxinfo/currwx/current.htm");
    expect(screen.queryByTestId("hko-warning")).toBeNull();
  });

  it("maintenance, not-yet-published and failed feeds say so instead of showing numbers", async () => {
    const p = PATHS("sc");
    vi.stubGlobal(
      "fetch",
      hkoFetch("sc", {
        [p.current]: async () => Promise.reject(new TypeError("Failed to fetch")),
        [p.hourly]: edited("hourlyRainfall", (doc) => {
          for (const r of doc.hourlyRainfall as Array<Record<string, unknown>>) if (r.automaticWeatherStation === "香港天文台") r.value = "M";
        }),
        [p.yesterday]: edited("RYES-20261003", (doc) => (doc.ReportTimeInfoDate = "20261002")),
      }),
    );
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-hour")).toHaveTextContent("维护中");
    expect(screen.getByTestId("hko-temperature")).toHaveTextContent("—读取失败");
    expect(screen.getByTestId("hko-humidity")).toHaveTextContent("—读取失败");
    expect(screen.getByTestId("hko-yesterday")).toHaveTextContent("—尚未发布");
    expect(screen.getByTestId("hko-times")).not.toHaveTextContent("天文台发布");
  });

  it("when nothing can be read it shows an error with a retry and no readings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-error")).toHaveTextContent("暂时读不到天文台数据：Failed to fetch。不显示替代数值。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByTestId("hko-temperature")).toBeNull();
  });

  it("shows a warning in force and calls out a report older than three hours", async () => {
    vi.setSystemTime(Date.parse("2026-10-04T11:30:00+08:00"));
    vi.stubGlobal("fetch", hkoFetch("sc", { [PATHS("sc").current]: edited("rhrread", (doc) => (doc.warningMessage = ["黄色暴雨警告信号现正生效。"])) }));
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-warning")).toHaveTextContent("黄色暴雨警告信号现正生效。");
    expect(screen.getByText("天文台报告已超过 3 小时未更新。")).toBeInTheDocument();
  });
});
