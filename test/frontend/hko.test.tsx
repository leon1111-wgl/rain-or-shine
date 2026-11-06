import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentWeatherUrl, hourlyRainfallUrl } from "../../src/weather/live";
import { ryesUrl } from "../../src/weather/profile";
import { HkoLivePanel } from "../../web/src/components/HkoLivePanel";
import { setActiveLocale } from "../../web/src/i18n";
import { clearHkoCache, HKO_UNREACHABLE, loadHkoLive, viaPageServer } from "../../web/src/lib/hko";

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
  setActiveLocale("zh-CN");
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
    expect(fetchImpl.mock.calls.map((c) => String(c[0])).filter((url) => url.startsWith("https://"))).toEqual([]);
    clearHkoCache();
    const down = vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadHkoLive("sc", down, () => CAPTURED_AT)).rejects.toThrow(HKO_UNREACHABLE);
  });

  it("on a static host with no relay it reads HKO's open-data host directly", async () => {
    const p = PATHS("sc");
    const direct = { current: currentWeatherUrl("sc"), hourly: hourlyRainfallUrl("sc"), yesterday: ryesUrl("20261003", "sc") };
    const routes: Record<string, string> = {
      [direct.current]: captured("rhrread", "sc"), [direct.hourly]: captured("hourlyRainfall", "sc"), [direct.yesterday]: captured("RYES-20261003", "sc"),
    };
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

  it.each([
    ["a failed connection", async () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a timeout", async () => Promise.reject(new DOMException("signal timed out", "TimeoutError"))],
    ["a relay that cannot reach HKO", async () => new Response("HKO unreachable: ECONNRESET\n", { status: 502 })],
  ])("after %s it says what to do, with a retry and no readings", async (_case, answer) => {
    vi.stubGlobal("fetch", vi.fn(answer));
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-error")).toHaveTextContent("当前网络连不上天文台。如果开了 VPN 或代理，请让 gov.hk 直连。市场和下注不受影响。");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.queryByTestId("hko-temperature")).toBeNull();
  });

  it("when HKO answers with an error it shows that error, not the network advice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("HKO answered HTTP 503\n", { status: 502 })));
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-error")).toHaveTextContent("暂时读不到天文台数据：HTTP 502。不显示替代数值。");
  });

  it("shows a warning in force and calls out a report older than three hours", async () => {
    vi.setSystemTime(Date.parse("2026-10-04T11:30:00+08:00"));
    vi.stubGlobal("fetch", hkoFetch("sc", { [PATHS("sc").current]: edited("rhrread", (doc) => (doc.warningMessage = ["黄色暴雨警告信号现正生效。"])) }));
    render(<HkoLivePanel />);
    expect(await screen.findByTestId("hko-warning")).toHaveTextContent("黄色暴雨警告信号现正生效。");
    expect(screen.getByText("天文台报告已超过 3 小时未更新。")).toBeInTheDocument();
  });
});
