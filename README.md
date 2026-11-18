# Trend Surf — cbBTC 24h bars race bot

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/gogonkoplo/btc-race-24h-entry-v2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/gogonkoplo/btc-race-24h-entry-v2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A slow trend-surfing trading bot for the [make.fun](https://make.fun) bounty
“Race a BTC trading bot live for 24 hours”. It trades cbBTC/USDC paper money
on one-minute bars through the agent-fun/bars-replay/v1 protocol: it only
buys inside a confirmed slow uptrend (EMA 30 above EMA 120, close above the
slow EMA, trailing 120-bar momentum at least +0.35%), stakes 95% of equity,
rests 30 bars after every exit, and leaves with wide exits — a −1.2% hard
stop, a +2.5% take-profit, a 0.7% trailing stop, or a regime break.

The grader runs it as `node main.ts` (Node 22, standard library only);
`vendor/makefun-bars.ts` is the kit's protocol shim, copied byte for byte.
Local dev-window grade: net PnL +3.598566 USDC over 4 trades.
