# Security

Rain or Shine runs on the Ethereum Sepolia test network with test ETH.

## On chain

- Bets, results and payouts live in two contracts. Nobody can edit them, us included.
- The contracts cannot be upgraded, paused or emptied.
- Sourcify verified the code on chain as an exact match of this repository:
  [PredictionMarket](https://repo.sourcify.dev/11155111/0x668643AF961C4032909C1c15A741b6d2d6216e92) and
  [UmaMetricOracleAdapter](https://repo.sourcify.dev/11155111/0x6927E0936D5B25B7aCea6582f0b1638C1bC6bedc).
- The administrator can register metrics and create markets. It cannot change a bet, a result or a payout.
- Only a market's named proposer can submit its result. The proposer cannot bet in that market.
- A result counts only when UMA calls back for the assertion the market recorded.
- Anyone can dispute a result for two hours. A disputed market refunds. It never pays the wrong side.
- Each result records a fingerprint of the HKO file it came from. Anyone can check the reading against that file.

## In the app

- The app has no server and holds no key. Your wallet signs every transaction.
- It sends transactions only on Sepolia, and only to the two contracts above.
- It compares the contracts on chain with its deployment record, at startup and before each transaction. If they differ, it stops.
- A Content Security Policy blocks outside scripts. The app connects only to its RPC providers and the Hong Kong
  Observatory.
- The app does not run inside another site's frame.
- A link from on-chain text opens only if it is an http or https address.

## In the code and downloads

- Every GitHub Action is pinned to an exact commit and gets only the permissions it needs.
- Every build checks the npm signature of every package.
- CodeQL and npm audit run on every push and every Monday. Dependabot reports vulnerable packages.
- Nobody can force-push or delete the main branch. Secret scanning blocks a pushed key.
- GitHub Actions builds and signs the desktop packages. To check a download:
  `gh attestation verify Rain-or-Shine-macOS-arm64.zip --repo leon1111-wgl/rain-or-shine`.

A check runs twice a day. It reports new alerts, failed builds and any change to the live page or the code.

## Limits

- Test ETH has no value. This is a course project.
- Sepolia has no UMA vote, so a disputed market refunds instead of being judged.
- The app reads the chain through public RPC providers. A dishonest provider could show wrong numbers. It cannot move
  your funds. Your wallet signs and sends each transaction.
- GitHub Pages cannot send security headers, so the web app sets its policy inside the page.
- Two build and test tools have published advisories with no fix in their current versions: Hardhat 3 and Mocha. They
  run only on a developer's computer and in CI. Neither ships in the app.

## Report a problem

Use "Report a vulnerability" in this repository's Security tab. The report stays private.
