// The whole market on a real local chain through the interface: bet, the opposite side refused, the proposer's
// result, settlement and the winner's claim. And a one-sided market's full refund. The local Mock stands in for
// UMA here. The Sepolia runs use the real OOV3.
import { expect, test, type Page } from "@playwright/test";
import { ADMIN, E, PROPOSER, account, chain, chainNow, createQuickMarket, createRainMarket, directBet, expectTx, fundProposer, installWallet, travelTo, quickReport } from "./helpers.js";

const english = async (page: Page) => page.addInitScript(() => localStorage.setItem("rainmark.locale", "en"));

async function connected(page: Page, account: number, hash: string) {
  await english(page);
  await installWallet(page, account);
  await page.goto(`/${hash}`);
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("wallet-account")).toBeVisible();
}

test("bet, refused opposite side, proposal, settlement and claim", async ({ browser }) => {
  const market = await createQuickMarket(30);
  const bettor = await (await browser.newContext()).newPage();
  await connected(bettor, 3, `#/market/${market.id}`);
  await bettor.getByTestId("side-YES").click();
  await bettor.getByTestId("amount").fill("0.02");
  await bettor.getByTestId("bet-submit").click();
  await bettor.getByTestId("bet-confirm").click();
  await expectTx(bettor, "ok");
  await expect(bettor.getByTestId("bet-done")).toBeVisible();
  await expect(bettor.getByTestId("done-position")).toContainText("0.020");
  // The opposite side is refused: disabled in the ticket, and reverted by the contract when sent directly.
  await expect(bettor.getByTestId("side-NO")).toBeDisabled();
  await expect(bettor.getByTestId("side-lock")).toContainText("YES");
  await expect(directBet(3, market.id, "NO", E(1))).rejects.toThrow();
  await directBet(4, market.id, "NO", E(10));

  // After the observation window the designated proposer imports the report, types its reading and submits it.
  await travelTo(market.times.earliestAssertionAt);
  await fundProposer();
  const proposer = await (await browser.newContext()).newPage();
  await connected(proposer, PROPOSER, `#/ops/${market.id}`);
  await proposer.getByTestId("result-file").setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from(quickReport("27.5")) });
  await proposer.getByTestId("result-reading-input").fill("27.5");
  await expect(proposer.getByTestId("result-reading")).toContainText("27.5");
  await proposer.getByTestId("approve-bond").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Approve proposal bond: complete");
  await proposer.getByTestId("propose").click();
  await expect(proposer.getByTestId("client-status")).toContainText("Submit observation assertion: complete");

  // After the challenge period anyone settles. The Yes bettor claims the whole market.
  await travelTo((await chainNow()) + 130);
  await bettor.goto(`/#/market/${market.id}/waiting`);
  await expect(bettor.getByTestId("settle")).toBeEnabled();
  await bettor.getByTestId("settle").click();
  await expect(bettor.getByTestId("client-status")).toContainText("Settle assertion: complete");
  await bettor.goto(`/#/market/${market.id}/settlement`);
  await expect(bettor.getByTestId("result-title")).toContainText("Yes");
  await expect(bettor.getByTestId("money-due")).toHaveText("0.030");
  await bettor.getByTestId("claim").click();
  await expectTx(bettor, "ok");
  await expect(bettor.getByTestId("claim-disabled")).toBeVisible();
  const { market: contract } = await chain(ADMIN);
  expect((await contract.getFunction("getPosition")(market.id, await account(3))).claimed).toBe(true);
});

test("a market with stakes on one side only refunds every stake after the close", async ({ browser }) => {
  const market = await createRainMarket(4);
  await directBet(5, market.id, "YES", E(7));
  await travelTo(market.times.closeAt);
  const page = await (await browser.newContext()).newPage();
  await connected(page, 5, `#/market/${market.id}/settlement`);
  await expect(page.getByTestId("result-title")).toContainText("only one side was staked");
  await expect(page.getByTestId("money-due")).toHaveText("0.007");
  await page.getByTestId("claim").click();
  await expectTx(page, "ok");
  await expect(page.getByTestId("claim-disabled")).toBeVisible();
});
