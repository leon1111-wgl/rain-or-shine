// Layout, language and the intro on a real local chain: no page scrolls sideways at desktop, laptop or phone width,
// the 中文 / EN switch changes every page, and the intro leads into the markets and can be skipped next time.
import { expect, test } from "@playwright/test";
import { E, chain, createFieldMarket, createOfficialMarket, createQuickMarket, createRainMarket, directBet, installWallet } from "./helpers.js";

let rain = 0;

test.beforeAll(async () => {
  rain = (await createRainMarket(3)).id;
  await createQuickMarket(60);
  // Every weather type, so the type chips are as wide as on Sepolia: rain, temperature, humidity and other.
  await createOfficialMarket("DAILY_MAX_TEMPERATURE", 3, "28.0");
  await createFieldMarket("mean-humidity", 3, "65", "75");
  await directBet(3, rain, "YES", E(10));
  await directBet(4, rain, "NO", E(5));
});

for (const [width, locale] of [[1440, "zh-CN"], [1024, "zh-CN"], [390, "zh-CN"], [360, "zh-CN"], [1440, "en"], [390, "en"], [360, "en"]] as const) {
  test(`no horizontal overflow at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((l) => localStorage.setItem("rainmark.locale", l), locale);
    await installWallet(page, 3);
    for (const hash of ["#/", "#/markets", "#/markets/ranks", "#/markets/data", `#/market/${rain}`, `#/market/${rain}/waiting`, `#/market/${rain}/settlement`, "#/mine", "#/ops"]) {
      await page.goto(`/${hash}`);
      await expect(page.locator(".topbar, .intro-nav").first()).toBeVisible(); // the intro has its own navigation
      await expect(page.getByTestId("render-fault")).toHaveCount(0);
      await page.waitForTimeout(1_500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${hash} at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
}

test("the weather-type chips scroll inside their own row on a phone, in both languages", async ({ page }) => {
  for (const [width, locale] of [[360, "en"], [390, "en"], [360, "zh-CN"], [390, "zh-CN"]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript((l) => localStorage.setItem("rainmark.locale", l), locale);
    // The intro first, as a visitor arrives. The markets page then has its final width.
    await page.goto("/#/");
    await page.goto("/#/markets");
    const chips = page.getByTestId("metric-filter");
    await expect(chips.getByRole("button")).toHaveCount(5);
    await expect(page.getByTestId("kind-filter-humidity")).toBeAttached();
    const box = await chips.boundingBox();
    expect(box && box.x + box.width, `chips at ${width}px in ${locale}`).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `page at ${width}px in ${locale}`).toBeLessThanOrEqual(0);
  }
});

test("the language switch changes the whole interface and is remembered", async ({ page }) => {
  await page.goto("/#/markets");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("天气预测");
  await expect(page.getByTestId("pool-card").first()).toContainText("天文台总部");
  await page.getByTestId("lang-en").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weather markets");
  await expect(page.getByTestId("pool-card").first()).toContainText("HKO headquarters");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Weather markets");
  await page.getByTestId("lang-zh-CN").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("天气预测");
});

test("the intro shows live figures from the chain, leads into the markets and can be skipped next time", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
  // The staked total is the chain's, read here independently of the page.
  const { market } = await chain(0);
  let staked = 0n;
  for (let id = 1; id <= Number(await market.getFunction("marketCount")()); id++) {
    const state = await market.getFunction("getMarketState")(id);
    staked += (state.yesTotal as bigint) + (state.noTotal as bigint);
  }
  expect(staked).toBeGreaterThan(0n);
  // The figures count up once their section is seen.
  await page.getByTestId("landing-figures").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("landing-figures")).toContainText(`${(Number(staked / 10n ** 15n) / 1000).toFixed(3)} ETH`);
  await expect(page.getByTestId("live-card")).toContainText(/天文台总部|HKO headquarters/);
  // The pill navigation follows the scroll.
  await page.getByTestId("intro-pill-faq").click();
  await expect(page.getByTestId("intro-pill-faq")).toHaveAttribute("aria-current", "true");
  await page.getByTestId("intro-pill-home").click();
  await page.getByTestId("enter-markets").click();
  await expect(page).toHaveURL(/#\/markets$/);
  await expect(page.getByTestId("pool-card").first()).toBeVisible();
  await page.goto("/");
  await page.getByTestId("skip-intro").check();
  await page.goto("/");
  await expect(page).toHaveURL(/#\/markets$/);
  // The intro stays one click away.
  await page.getByRole("link", { name: "Rain or Shine" }).click();
  await expect(page.getByTestId("landing")).toBeVisible();
  await expect(page.getByTestId("skip-intro")).toBeChecked();
  await page.getByTestId("skip-intro").uncheck();
  await page.goto("/");
  await expect(page.getByTestId("landing")).toBeVisible();
});
