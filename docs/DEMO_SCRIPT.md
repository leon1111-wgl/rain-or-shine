# Rain or Shine demo script

A video of at most 15 minutes, recorded on the Sepolia deployment. Times are a guide. "Show" is what is on screen.
"Say" is what the presenter says. Show only what the chain holds at the time of recording. The app shows every hash
and result as it is. Read them from the screen. Never prepare them in advance.

## Before recording

- Open the app against Sepolia (`npm run dev:metric:sepolia`) in a browser with MetaMask on Sepolia.
- The MetaMask account needs a little Sepolia ETH. A bet is at least 0.001 ETH, plus gas.
- The account must not be a market's proposer. The contract refuses bets from the proposer, and the bet panel says
  so.
- Know the six markets and their schedule. All times are Hong Kong time.

| Market | Question | Betting closes | Result proposed | Settled |
| --- | --- | --- | --- | --- |
| 1 | Rain ≥ 1.0 mm on 3 Nov | 2 Nov 23:59 | 4 Nov, after HKO publishes the Daily Extract | about 2 h later |
| 2 | Maximum temperature ≥ 28.0 °C on 4 Nov | 3 Nov 23:59 | 5 Nov, after publication | about 2 h later |
| 3 | Rain ≥ 1.0 mm on 5 Nov | 4 Nov 23:59 | 6 Nov, after publication | about 2 h later |
| 4 | Maximum temperature ≥ 29.0 °C on 5 Nov | 4 Nov 23:59 | 6 Nov, after publication | about 2 h later |
| 5 (custom) | Minimum temperature ≤ 25.0 °C on 5 Nov | 4 Nov 23:59 | 6 Nov, after publication | about 2 h later |
| 6 (custom) | Mean relative humidity 65–75 % (inclusive) on 5 Nov | 4 Nov 23:59 | 6 Nov, after publication | about 2 h later |

- Pick the market to bet on: one whose betting is still open on the recording day.

## 0:00–1:30 Landing

Show: the intro page at `#/`. Scroll slowly from the top.

Say:
- "Rain or Shine is a prediction market on Hong Kong weather."
- "Each market asks one question, such as whether HKO headquarters records 1 mm of rain on a given day."
- "You take Yes or No with test ETH. The Observatory's reading decides the result, and UMA's oracle confirms it."
- Point at the live card: "This is the busiest open market. The line is its Yes share after each bet."
- Point at the figures: "Every number here is read from the contract when the page opens."
- Point at the three market cards: "Rainfall and maximum temperature are the official markets. Custom markets read
  other weather values."
- Point at the six steps and the fee table: "There is no platform fee. Winners share all the stakes."
- Click "Enter markets".

## 1:30–3:30 Markets

Show: the markets page.

Say:
- "The first tab lists the markets. The others rank them and show trading data."
- Click "Rankings", then "Trading data", then back to "Markets".
- Use the filters: "All", "Open", "Waiting", "Settled / refund". Use the weather-type chips: "Rain", "Temperature"
  and "Humidity". Each shows how many markets it holds. Type a date such as "11-05" in the search box.
- Point at the HKO live panel: "This is the Observatory's latest reading. The link checks it on the official site.
  It is only context. Results come from the Daily Extract."
- "Each row shows the Yes share, the change over 24 hours, the stakes on each side and the time left to bet."

## 3:30–6:00 Detail

Show: open the market you will bet on.

Say:
- "The header shows the question, the source, the Yes share and the stakes on each side."
- Point at the chart: "Yes share after each bet. The other tab shows the cumulative stakes."
- Point at "Positions": "Who holds which side, and their part of that side."
- Click "Latest trades" in the same card, then the "Trades" list below: "Every bet, with its transaction link."
- Point at the Yes share tip: "The Yes share is the crowd's chance of Yes. It is not a price."
- Click "Rules": "The spec comes first: the question, the source, the condition, the times, and what happens
  otherwise. HKO publishes a day's data on the next working day, around 10:30."
- Click "Rules document": "These rules were fixed when the market was created. Their hash is stored in the contract.
  Nobody can change them later."

## 6:00–8:30 A bet from MetaMask

Show: the bet panel on the same page.

Say and do:
- "I connect my own MetaMask." Connect, and switch to Sepolia if asked.
- Pick Yes or No and type an amount, for example 0.002.
- Point at "If Yes wins, about … ETH": "This is the payout estimate. It uses the contract's own formula on the
  current stakes plus my bet. It moves as other people bet."
- If the other side is still empty, the panel says the market refunds unless someone takes that side. Say so.
- Click "Review and confirm the bet". In the dialog: "The network, the market, the exact amount in wei, the gas and
  the estimate. I see them all before the wallet asks me to sign. The fee line says none."
- Confirm in MetaMask. Wait for the confirmation in the app.
- "My first bet locks my side. I can add to it, but not switch."

## 8:30–10:30 Waiting for the result

Show: the "Waiting for result" view of market 1 (or of a market past its betting close).

Say:
- Point at the steps: "Betting closed, observation ended, valid report, challenge period, then settlement or refund."
- Point at the note under the steps: "HKO publishes on the next working day. The proposer has a fixed window to
  submit. Without a settled result by the refund deadline, everyone is refunded."
- Before the proposal (before 4 Nov for market 1): "The proposer has not submitted the reading yet. The page says
  so and shows when it can."
- After the proposal: "The proposer submitted the Daily Extract reading to UMA with a bond." Point at the assertion
  and at "View the evidence": "The evidence on chain includes the hash of the Observatory's file."
- Point at "Challenge period left": "Anyone can dispute during these two hours."
- "When the challenge period ends, anyone can settle. An undisputed result is settled first, even after the refund
  deadline. Nobody can claim or take a refund before that."
- "A rejected result is not a No. It refunds everyone at once."

## 10:30–12:00 Settlement and claim

Show: the "Settlement & refund" view of a settled market. If none is settled yet, show the waiting view. Say when
the first settlement is due: 4 Nov, about 2 hours after the proposal.

Say:
- "The result and the reading it came from."
- "Winners claim their share. It is computed from the stake and rounded down once."
- If the presenter's side won, click "Claim winnings" and confirm in MetaMask. Otherwise show the button state.
- "If a market refunds, the same button returns the stake."

## 12:00–12:30 My participation

Show: "My participation".

Say:
- "Every market I bet on, my side, my stake, and what I can claim."
- "Claims are made here or on each market's settlement view."

## 12:30–13:30 Custom markets (optional, shorten the oracle story to fit)

Show: the markets list, then market #6's detail page and its "Rules" tab.

Two custom markets for 5 November run on the same Sepolia deployment, both read from the HKO Daily Extract:

- Market #5: minimum temperature at or below 25.0 °C (metric DAILY_MIN_TEMPERATURE).
- Market #6: mean relative humidity between 65 % and 75 %, both bounds included (metric DAILY_MEAN_HUMIDITY, a range).

On the local chain, the seeded markets #5 (temperature at 15:00, a range) and #6 (mean humidity, a range) show the
same views. The local Operations page also shows the new-market flow. Pick a metric card, set the condition and the
day, check the preview, then create. A preset that is not registered yet takes two wallet confirmations. Below the
weather cards, the local chain also offers two sports demos. Seeded market #8 is a settled basketball demo with the
"Demo" label.

Say:
- Point at the "Official" and "Custom" labels: "Rainfall and maximum temperature are the official metrics. The
  administrator can add custom ones."
- Open the custom market's rules: "A custom market names its data source, its link and how to read it. The range
  includes both bounds."
- "The proposer imports that source document, or pastes its text. Then the proposer types the reading. Its data
  fingerprint goes on chain. Anyone can check the same document."
- Optional, on the local chain: "The same contract also runs a sports demo. Its result is a synthetic file, so it
  stays off Sepolia."

## 13:30–15:00 The oracle story

Show: the waiting view of a market with a proposal, or the rules document if none has been proposed yet.

Say:
- "One: the Observatory publishes its Daily Extract for the day."
- "Two: the market's proposer submits the reading with evidence. The evidence includes the hash of the published
  file. Anyone can download it and compare."
- "Three: UMA's Optimistic Oracle V3 holds the claim with a 6TEST bond for a two-hour challenge period."
- "Four: if nobody disputes it, anyone settles. The contract then checks the reading against the threshold and
  decides Yes or No."
- "On Sepolia UMA has no voting for disputes. A disputed claim is refunded at the market's refund deadline."
- Close on the markets page: "Everything you saw is read from the contracts. Thank you."
