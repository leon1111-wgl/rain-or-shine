# Security

Rain or Shine runs on Ethereum Sepolia, a test network, with test ETH. This page says what protects the markets, the
app and the downloads, which limits we accept, and how to report a problem.

## The markets on chain

- Bets, results and payouts live in two contracts on Sepolia. Nobody can edit them, us included.
- The code on chain is the code in this repository. Sourcify verified both contracts as an exact match:
  [PredictionMarket](https://repo.sourcify.dev/11155111/0x668643AF961C4032909C1c15A741b6d2d6216e92) and
  [UmaMetricOracleAdapter](https://repo.sourcify.dev/11155111/0x6927E0936D5B25B7aCea6582f0b1638C1bC6bedc).
- The contracts cannot be upgraded, paused or emptied. The administrator can register metrics and create markets.
  It cannot change a bet, a result or a payout. The oracle adapter was set once and cannot be replaced.
- Only the proposer named in a market can submit its result, and the proposer cannot bet in that market.
- A result counts only when UMA's Optimistic Oracle V3 calls back, and only for the assertion the market recorded.
- Each result names the HKO file it was read from and records that file's SHA-256 on chain, so anyone can check the
  reading against the same bytes.
- Anyone can dispute a result during its challenge window: two hours for the official markets. A disputed market never
  pays the wrong side. Sepolia has no UMA vote, so the market refunds every stake at its refund time.
- A wallet keeps one side in a market. Amounts are whole numbers of wei.
- The contract tests attack the market on purpose: a reentrant claim, writes and callbacks from untrusted accounts, a
  proposal from the wrong account, a late or repeated oracle answer, and a third party's assertion aimed at the adapter.

## The app

- The app has no server and holds no key. Your wallet signs every transaction.
- It sends transactions only on Sepolia, and only to the two contracts above. Their addresses are built into the app.
- A Content Security Policy lets the app run only its own scripts and connect only to its RPC providers and the Hong
  Kong Observatory. The desktop app also sends its policy as an HTTP header.
- The app does not run inside another site's frame, so nobody can lay it under a fake page to steal a click.
- A link that comes from on-chain text opens only if it is an http or https address.

## The code and the downloads

- Every GitHub Action is pinned to an exact commit and gets only the permissions it needs.
- Every build checks the npm registry signature of every package.
- CodeQL and npm audit run on every push and every Monday. Dependabot reports and fixes vulnerable packages.
- Nobody can force-push or delete the main branch. Secret scanning blocks a pushed key.
- GitHub Actions builds the desktop packages and signs where and how each one was built. Check a download with
  `gh attestation verify Rain-or-Shine-macOS-arm64.zip --repo leon1111-wgl/rain-or-shine`.
- The packager checks each Node.js runtime against the SHA-256 list that nodejs.org publishes.

## Watching

A check runs twice a day. It restarts a stopped background job. It reports when the main branch on GitHub or the live
page differs from what we published.

## Limits we accept

- Test ETH has no value. This is a course project, not a product.
- Sepolia has no UMA vote, so a disputed market refunds instead of being judged.
- The app reads the chain through public RPC providers. A dishonest provider could show wrong numbers. It cannot send
  your bet elsewhere or move your funds: the contract addresses are built in, and your wallet signs and sends each
  transaction itself.
- GitHub Pages cannot send security headers, so the web app sets its policy inside the page.
- We run no server of our own. GitHub's network takes the load of a traffic flood.

## Report a problem

Use "Report a vulnerability" in this repository's Security tab. The report stays private. Please do not open a public
issue for a security problem.
