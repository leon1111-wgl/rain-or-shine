import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { sha256 } from "ethers";
import { ADMIN, PROPOSER, account, chain, chainNow, createRainMarket, expectTx, fundProposer, installWallet, travelTo } from "./helpers.js";

const HOUR = 3_600;
const RESULT_FILE = "fixtures/demo/sports/basketball-lal-bos.json";
const hktInput = (unix: number) => new Date((unix + 8 * HOUR) * 1000).toISOString().slice(0, 16);

async function connected(page: Page, who: number, hash: string) {
  await page.addInitScript(() => localStorage.setItem("rain-or-shine.locale", "en"));
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

test("a sports demo from its card to the claim: Demo tag, Sports chip, synthetic result file", async ({ browser }) => {
  await createRainMarket();
  const admin = await (await browser.newContext()).newPage();
  await connected(admin, ADMIN, "#/ops");
  const form = admin.getByTestId("create-market");
  await expect(form.getByTestId("demo-choices")).toContainText("Sports demo");
  await form.getByTestId("choice-sports:SCORE_MARGIN").click();
  await expect(form.getByTestId("match-id")).toHaveValue("LAL_BOS_DEMO01");
  const start = Math.ceil(((await chainNow()) + 30 * 60) / 900) * 900;
  await form.getByTestId("custom-start").fill(hktInput(start));
  await form.getByTestId("custom-end").fill(hktInput(start + 2.5 * HOUR));
  await form.getByText("Advanced timing").click();
  await form.getByLabel("Result proposer address (leave blank for current account)").fill(await account(PROPOSER));
  await expect(form.getByTestId("preview-question")).toHaveText("LAL vs BOS: will the margin (LAL − BOS) be > 0 points?");
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(form.getByTestId("custom-create")).toHaveText("Register and create");
  await form.getByTestId("custom-create").click();
  await expect(admin.getByTestId("client-status")).toContainText("2/2 Create market: complete");
  await expect(admin.getByTestId("metric-row-SCORE_MARGIN")).toContainText("Demo");
  const { market } = await chain(ADMIN);
  const id = Number(await market.getFunction("marketCount")());
  const times = (await market.getFunction("getMarketConfig")(id)).times;

  await travelTo(times.openAt);
  const yes = await (await browser.newContext()).newPage();
  await connected(yes, 3, `#/market/${id}`);
  await expect(yes.getByTestId("market-question")).toHaveText("LAL vs BOS: will the margin (LAL − BOS) be > 0 points?");
  await expect(yes.getByTestId("pool-detail").getByTestId("market-tag").first()).toHaveAttribute("data-tag", "demo");
  await yes.getByTestId("detail-tab-rules").click();
  await expect(yes.getByTestId("demo-note")).toContainText("not a real match");
  await bet(yes, id, "YES", "0.02");
  const no = await (await browser.newContext()).newPage();
  await connected(no, 4, `#/market/${id}`);
  await bet(no, id, "NO", "0.01");
  await yes.goto("/#/markets");
  await yes.getByTestId("kind-filter-sport").click();
  const card = yes.locator(`[data-testid="pool-card"][data-market="${id}"]`);
  await expect(card.getByTestId("market-tag")).toHaveText("Demo");

  await travelTo(times.earliestAssertionAt);
  await fundProposer();
  const proposer = await (await browser.newContext()).newPage();
  await connected(proposer, PROPOSER, `#/ops/${id}`);
  await expect(proposer.getByText("Synthetic match results are for the demo only.")).toBeVisible();
  await proposer.getByTestId("result-file").setInputFiles(RESULT_FILE);
  await expect(proposer.getByTestId("result-reading")).toContainText("7 points");
  await proposer.getByRole("button", { name: "Check result" }).click();
  await expect(proposer.getByTestId("result-outcome")).toContainText("the market resolves Yes");
  await proposer.getByTestId("approve-bond").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Approve proposal bond: complete");
  await proposer.getByTestId("propose").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Submit observation assertion: complete");
  const assertion = await market.getFunction("getAssertion")(id);
  expect([assertion.reading.kind, assertion.reading.value, assertion.rawSha256]).toEqual([1n, 700n, sha256(readFileSync(RESULT_FILE))]);

  await travelTo((await chainNow()) + 130);
  await yes.goto(`/#/market/${id}/waiting`);
  await yes.getByTestId("settle").click();
  await expect(yes.getByTestId("client-status")).toContainText("Settle assertion: complete");
  await yes.goto(`/#/market/${id}/settlement`);
  await expect(yes.getByTestId("result-title")).toContainText("Yes");
  await expect(yes.getByText("The demo file records 7 points, so Yes. It is synthetic data.")).toBeVisible();
  await expect(yes.getByTestId("money-due")).toHaveText("0.030");
  await yes.getByTestId("claim").click();
  await expectTx(yes, "ok");
  expect((await market.getFunction("getPosition")(id, await account(3))).claimed).toBe(true);
});
