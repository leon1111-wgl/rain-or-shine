// Custom metrics on a real local chain through the interface. The administrator defines a metric and its first
// market in one flow: an inclusive range, its own source and procedure, and a one-hour window. Two accounts bet both
// sides. The proposer pastes the source document and its reading, sees the contract's outcome and submits it. The local
// Mock stands in for UMA, as in flow.spec.ts. Then come settlement and the winner's claim. A second test creates more
// custom markets from the shared builders and checks how the interface reads them.
import { expect, test, type Page } from "@playwright/test";
import { sha256, toUtf8Bytes } from "ethers";
import { customMetricRulesDocument } from "../../src/metric/custom-profile.js";
import {
  ADMIN, E, PROPOSER, account, chain, chainNow, createCustomMarket, directBet, expectTx, fundProposer, installWallet, registeredMetricId, travelTo,
} from "./helpers.js";

const HOUR = 3_600;
const DAY = 86_400;
/** Unix seconds as the form's Hong Kong datetime-local value. */
const hktInput = (unix: number) => new Date((unix + 8 * HOUR) * 1000).toISOString().slice(0, 16);
/** The next Hong Kong midnight after `unix`. */
const nextHkMidnight = (unix: number) => Math.floor((unix + 8 * HOUR) / DAY) * DAY + DAY - 8 * HOUR;

async function connected(page: Page, who: number, hash: string, locale = "en") {
  await page.addInitScript((l) => localStorage.setItem("rainmark.locale", l), locale);
  await installWallet(page, who);
  await page.goto(`/${hash}`);
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("wallet-account")).toBeVisible();
}

async function bet(page: Page, id: number, side: "YES" | "NO", amount: string) {
  await page.goto(`/#/market/${id}`);
  await page.getByTestId(`side-${side}`).click();
  await page.getByTestId("amount").fill(amount);
  await page.getByTestId("bet-submit").click();
  await page.getByTestId("bet-confirm").click();
  await expectTx(page, "ok");
  await expect(page.getByTestId("bet-done")).toBeVisible();
}

test("a custom metric from registration to claim: inclusive range, pasted source document, settlement", async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await connected(admin, ADMIN, "#/ops");
  // One flow: a new metric, its source and procedure, an inclusive range and a one-hour window.
  const form = admin.getByTestId("create-market");
  await form.getByTestId("choice-new").click();
  await form.getByLabel("Metric code").fill("MSL_PRESSURE");
  await form.getByLabel("Unit").fill("hPa");
  await form.getByLabel("Minimum reading").fill("0");
  await form.getByLabel("Maximum reading").fill("2000");
  await form.getByLabel("Reading step").fill("0.01");
  await form.getByLabel("Metric definition and calculation rules").fill("Mean sea-level pressure at HKO headquarters at the end of the observation window, in hPa.");
  const source = { name: "Hourly pressure log", url: "https://example.org/pressure/hourly.csv", procedure: "Read the PRESSURE column of the row at the end of the window." };
  await form.getByTestId("custom-source-name").fill(source.name);
  await form.getByTestId("custom-source-url-input").fill(source.url);
  await form.getByTestId("custom-procedure-input").fill(source.procedure);
  await form.getByLabel("Comparison").selectOption("5");
  await form.getByLabel("Lower bound").fill("1005");
  await form.getByLabel("Upper bound").fill("1015");
  await form.getByTestId("custom-window-mode").selectOption("window");
  const start = Math.ceil(((await chainNow()) + 30 * 60) / 900) * 900;
  await form.getByTestId("custom-start").fill(hktInput(start));
  await form.getByTestId("custom-end").fill(hktInput(start + HOUR));
  await form.getByText("Advanced timing").click();
  await form.getByLabel("Result proposer address (leave blank for current account)").fill(await account(PROPOSER));
  await expect(form.getByTestId("preview-question")).toContainText("between 1005.0 hPa and 1015.0 hPa (inclusive)");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByTestId("custom-create")).toHaveText("Register and create");
  await form.getByTestId("custom-create").click();
  await expect(admin.getByTestId("client-status")).toContainText("2/2 Create market: complete");
  const metricId = await registeredMetricId("MSL_PRESSURE");
  expect(metricId).toBeGreaterThan(0);
  await expect(admin.getByTestId("metric-row-MSL_PRESSURE")).toBeVisible();
  const { market } = await chain(ADMIN);
  const id = Number(await market.getFunction("marketCount")());
  await expect(form.getByRole("link", { name: `Open market #${id}` })).toHaveAttribute("href", `#/market/${id}`);
  const times = (await market.getFunction("getMarketConfig")(id)).times;
  expect([Number(times.closeAt), Number(times.observationStart), Number(times.observationEnd)]).toEqual([start, start, start + HOUR]);

  // Both sides from two accounts. The market reads as a custom question with its source in the rules.
  await travelTo(times.openAt);
  const yes = await (await browser.newContext()).newPage();
  await connected(yes, 3, `#/market/${id}`);
  await expect(yes.getByTestId("market-question")).toContainText("MSL PRESSURE");
  await expect(yes.getByTestId("market-question")).toContainText("between 1005.0 hPa and 1015.0 hPa (inclusive)");
  await expect(yes.getByTestId("pool-detail").getByTestId("market-tag").first()).toHaveAttribute("data-tag", "custom");
  await yes.getByTestId("detail-tab-rules").click();
  await expect(yes.getByTestId("custom-source-url")).toHaveText(source.url);
  await expect(yes.getByTestId("custom-procedure")).toHaveText(source.procedure);
  await bet(yes, id, "YES", "0.02");
  const no = await (await browser.newContext()).newPage();
  await connected(no, 4, `#/market/${id}`);
  await bet(no, id, "NO", "0.01");

  // After the window the proposer pastes the source document, types the reading and sees the contract's outcome.
  await travelTo(times.earliestAssertionAt);
  await fundProposer();
  const proposer = await (await browser.newContext()).newPage();
  await connected(proposer, PROPOSER, `#/ops/${id}`);
  const document = "time,pressure\n2026-11-05 15:00,1009.40\n";
  await proposer.getByTestId("result-paste").fill(document);
  await proposer.getByTestId("result-use-paste").click();
  await expect(proposer.getByText("Imported: Pasted text.")).toBeVisible();
  await proposer.getByTestId("result-reading-input").fill("1009.4");
  await expect(proposer.getByTestId("result-sha256").locator("span[title]")).toHaveAttribute("title", sha256(toUtf8Bytes(document)));
  await proposer.getByRole("button", { name: "Check result" }).click();
  await expect(proposer.getByTestId("result-outcome")).toContainText("the market resolves Yes");
  await proposer.getByTestId("approve-bond").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Approve proposal bond: complete");
  await proposer.getByTestId("propose").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Submit observation assertion: complete");
  const assertion = await market.getFunction("getAssertion")(id);
  expect([assertion.reading.kind, assertion.reading.value, assertion.rawSha256]).toEqual([1n, 100_940n, sha256(toUtf8Bytes(document))]);

  // After the challenge period anyone settles. The Yes bettor claims the whole market.
  await travelTo((await chainNow()) + 130);
  await yes.goto(`/#/market/${id}/waiting`);
  await expect(yes.getByTestId("settle")).toBeEnabled();
  await yes.getByTestId("settle").click();
  await expect(yes.getByTestId("client-status")).toContainText("Settle assertion: complete");
  await yes.goto(`/#/market/${id}/settlement`);
  await expect(yes.getByTestId("result-title")).toContainText("Yes");
  await expect(yes.getByTestId("money-due")).toHaveText("0.030");
  await yes.getByTestId("claim").click();
  await expectTx(yes, "ok");
  await expect(yes.getByTestId("claim-disabled")).toBeVisible();
  expect((await market.getFunction("getPosition")(id, await account(3))).claimed).toBe(true);
});

test("custom weather markets read well in both languages and take an imported file", async ({ browser }) => {
  const day = nextHkMidnight((await chainNow()) + HOUR);
  const metric = (code: string, unit: string, minValue: number, maxValue: number, valueStep: number, interpretation: string) =>
    customMetricRulesDocument({ code, unit, minValue, maxValue, valueStep, allowsTrace: false, interpretation });
  const source = (sourceName: string, sourceUrl: string) => ({ sourceName, sourceUrl, procedure: `Read the value for the observation window from ${sourceName}.` });
  const week = await createCustomMarket({
    metric: metric("WEEKLY_RAINFALL", "mm", 0, 999_990, 10, "Total rainfall at HKO headquarters over the observation window, the sum of the daily totals."),
    comparison: 4, lower: "20", start: day, end: day + 7 * DAY, source: source("HKO Daily Extract", "https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_202611.xml"), title: "Weekly rainfall at least 20 mm",
  });
  const band = await createCustomMarket({
    metric: metric("AFTERNOON_TEMPERATURE", "degC", -10_000, 10_000, 10, "Air temperature at HKO headquarters at the end of the observation window."),
    comparison: 5, lower: "25", upper: "28", start: day + 14 * HOUR, end: day + 17 * HOUR, source: source("HKO current weather report", "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en"), title: "Afternoon temperature 25 to 28 C",
  });
  const fall = await createCustomMarket({
    metric: metric("PRESSURE_CHANGE", "hPa", -50_000, 50_000, 100, "Change in mean sea-level pressure at HKO headquarters over the window, in whole hPa."),
    comparison: 1, lower: "-5", start: day + 19 * HOUR + 30 * 60, end: day + 22 * HOUR, source: source("Hourly pressure log", "https://example.org/pressure/hourly.csv"), title: "Pressure falls by more than 5 hPa",
  });
  const gust = await createCustomMarket({
    metric: metric("PEAK_GUST", "kmh", 0, 100_000, 1, "Highest gust at Waglan Island over the observation window, in km/h with two decimals."),
    comparison: 2, lower: "60", start: day + 15 * HOUR, end: day + 16 * HOUR, source: source("Regional wind report", "https://example.org/wind/waglan.csv"), title: "Gust at most 60 km/h",
  });
  // Both sides are staked, so the gust market takes a result instead of refunding at its close.
  await directBet(3, gust.id, "YES", E(10));
  await directBet(4, gust.id, "NO", E(5));

  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.setItem("rainmark.locale", "en"));
  await page.goto("/#/markets");
  const row = (id: number) => page.locator(`[data-testid="pool-card"][data-market="${id}"]`);
  const english: Array<[number, RegExp]> = [
    [week.id, /WEEKLY RAINFALL, \d{1,2} \w{3} to \d{1,2} \w{3}: will it be ≥ 20\.0 mm\?/],
    [band.id, /AFTERNOON TEMPERATURE, \d{1,2} \w{3} 14:00–17:00: will it be between 25\.0 °C and 28\.0 °C \(inclusive\)\?/],
    [fall.id, /PRESSURE CHANGE, \d{1,2} \w{3} 19:30–22:00: will it be < -5 hPa\?/],
    [gust.id, /PEAK GUST, \d{1,2} \w{3} 15:00–16:00: will it be ≤ 60\.0 kmh\?/],
  ];
  for (const [id, question] of english) {
    await expect(row(id)).toContainText(question);
    await expect(row(id).getByTestId("market-tag")).toHaveAttribute("data-tag", "custom");
  }
  await page.getByTestId("lang-zh-CN").click();
  const chinese: Array<[number, RegExp]> = [
    [week.id, /\d{1,2}月\d{1,2}日至\d{1,2}月\d{1,2}日 WEEKLY RAINFALL ≥ 20\.0 毫米？/],
    [band.id, /\d{1,2}月\d{1,2}日 14:00–17:00 AFTERNOON TEMPERATURE 介于 25\.0 °C 与 28\.0 °C 之间（含两端）？/],
    [fall.id, /\d{1,2}月\d{1,2}日 19:30–22:00 PRESSURE CHANGE < -5 hPa？/],
  ];
  for (const [id, question] of chinese) await expect(row(id)).toContainText(question);
  await expect(row(gust.id).getByTestId("market-tag")).toHaveText("自定义");

  // The gust market closes. Its proposer imports the report, and the contract says the reading resolves Yes.
  await travelTo(gust.times.earliestAssertionAt);
  await fundProposer();
  const proposer = await (await browser.newContext()).newPage();
  await connected(proposer, PROPOSER, `#/ops/${gust.id}`);
  const file = Buffer.from("time,gust\n2026-11-05 16:00,48.20\n");
  await proposer.getByTestId("result-file").setInputFiles({ name: "waglan-gust.csv", mimeType: "text/csv", buffer: file });
  await expect(proposer.getByText("Imported: waglan-gust.csv.")).toBeVisible();
  await proposer.getByTestId("result-reading-input").fill("48.20");
  await expect(proposer.getByTestId("result-sha256").locator("span[title]")).toHaveAttribute("title", sha256(file));
  await proposer.getByRole("button", { name: "Check result" }).click();
  await expect(proposer.getByTestId("result-outcome")).toContainText("the market resolves Yes");
  await proposer.getByTestId("approve-bond").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Approve proposal bond: complete");
  await proposer.getByTestId("propose").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Submit observation assertion: complete");
  const { market } = await chain(ADMIN);
  expect((await market.getFunction("getAssertion")(gust.id)).rawSha256).toBe(sha256(file));
});
