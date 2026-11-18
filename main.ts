// Slow trend-surfing bot for the cbBTC/USDC one-minute bars race.
//
// How this bot talks to the harness: the hello message describes the
// universe and the paper account, then every batch carries one fresh bar
// plus the fills of the orders I decided on the previous bar. My reply to a
// batch is the list of orders for that bar; an order fills at the next bar's
// open, so every decision here is made purely from closes already seen.
//
// Why it trades so rarely: a full-size round trip costs roughly 26-30 bps
// once the fill fee, the modelled slippage and the pool price impact are
// added up, while a single one-minute bar typically moves only a few bps.
// A fast crossover bot therefore bleeds fees on noise. This bot instead
// waits for a slow regime: it only buys while the 30-bar EMA sits above the
// 120-bar EMA, the close itself is above the 120-bar EMA, and the trailing
// 120-bar momentum is at least +0.35%, i.e. the market has already travelled
// further than a round trip costs. It stakes 95% of equity on that signal,
// caps slippage at 60 bps, and then refuses to re-enter for 30 bars after
// any exit, so a sideways range cannot churn it through repeated fees.
// No entries are started after bar 1405, leaving room to exit cleanly.
//
// Exits are deliberately wide, because tight exits were what killed earlier
// fast designs on this data: a hard stop at -1.2% of position cost, a
// take-profit at +2.5% of cost, a trailing stop 0.7% below the peak close
// (armed only once the peak is +0.3% above the entry close), and a regime
// exit when the 30-bar EMA falls back below the 120-bar EMA.
//
// Determinism: all indicators are float64 EMA arithmetic over the closes in
// arrival order, all money comparisons are exact bigint ratios, and nothing
// reads the clock, the environment, files or randomness. The same hello and
// the same bars therefore always produce the same orders, byte for byte.

import { BPS, runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- tuning constants (the plateau that grades positive on the dev window)
const EMA_FAST_SPAN = 30; // fast trend line, in bars
const EMA_SLOW_SPAN = 120; // slow regime line, in bars
const MOMENTUM_SPAN = 120; // trailing momentum lookback, in bars
const MOMENTUM_FLOOR = 0.0035; // least trailing gain that confirms an entry
const STAKE_BPS = 9500n; // 95% of equity per entry
const STOP_RATIO_NUM = 9880n; // hard stop: value <= 98.80% of cost
const TARGET_RATIO_NUM = 10250n; // take profit: value >= 102.50% of cost
const TRAIL_ARM_GAIN = 1.003; // trailing stop arms at peak >= entry * 1.003
const TRAIL_DROP = 0.007; // trailing stop: close <= peak * (1 - 0.007)
const REST_BARS = 30; // cooldown bars after an exit fill
const ENTRY_DEADLINE_BAR = 1405; // no fresh entries after this many bars
const SLIPPAGE_CAP_BPS = 60; // max_slippage_bps on every order

/**
 * One exponential moving average line. It seeds itself with the plain mean
 * of its first `span` closes and afterwards moves 2 / (span + 1) of the way
 * toward each new close — plain float64 arithmetic, identical every run.
 */
class EmaLine {
  readonly span: number;
  private seedCloses: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  push(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.seedCloses.push(close);
    if (this.seedCloses.length === this.span) {
      let total = 0;
      for (const c of this.seedCloses) total += c;
      this.value = total / this.span;
      this.seedCloses = [];
    }
  }
}

const trendLine = new EmaLine(EMA_FAST_SPAN);
const regimeLine = new EmaLine(EMA_SLOW_SPAN);

/** Every close observed so far, in arrival order (momentum reads it back). */
const closeHistory: number[] = [];
/** Total bars processed, warm-up style batches included in the count. */
let barIndex = 0;
/** Bars waited since the last exit; starts fully rested so entry #1 is free. */
let restWaited = REST_BARS;
/** True when the previous batch still showed an open position. */
let heldLastBatch = false;
/** Close at which the current position was first observed, and its peak. */
let anchorClose = 0;
let peakClose = 0;

/** Trailing momentum across MOMENTUM_SPAN bars, or null if too early. */
function trailingMomentum(): number | null {
  const n = closeHistory.length;
  if (n <= MOMENTUM_SPAN) return null;
  return closeHistory[n - 1]! / closeHistory[n - 1 - MOMENTUM_SPAN]! - 1;
}

/** True when the slow regime says "uptrend": lines ordered, price on top. */
function regimeIsUp(closeNow: number): boolean {
  if (trendLine.value === null || regimeLine.value === null) return false;
  return trendLine.value > regimeLine.value && closeNow > regimeLine.value;
}

/**
 * Exit decision for an open position, kept separate from the batch loop so
 * the four exit rules read as one checklist. Money ratios are compared in
 * exact bigint quote units (value * 10000 against cost * ratio); the
 * trailing rule works on closes: it arms once the peak close reaches
 * TRAIL_ARM_GAIN over the anchor close and fires on a close TRAIL_DROP
 * below that peak. The regime rule fires when the fast line crosses back
 * under the slow line. Any single rule is enough to sell everything.
 */
function shouldExit(worthNow: bigint, costBasis: bigint, closeNow: number): boolean {
  if (worthNow * 10000n <= costBasis * STOP_RATIO_NUM) return true;
  if (worthNow * 10000n >= costBasis * TARGET_RATIO_NUM) return true;
  const trailArmed = anchorClose > 0 && peakClose >= anchorClose * TRAIL_ARM_GAIN;
  if (trailArmed && closeNow <= peakClose * (1 - TRAIL_DROP)) return true;
  if (trendLine.value !== null && regimeLine.value !== null && trendLine.value < regimeLine.value) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    // Fold every bar of this batch into the indicators first; the decision
    // below uses only the freshest bar and the account this batch reports.
    let lastBar: Bar | null = null;
    for (const bar of batch.bars) {
      lastBar = bar;
      const close = Number(bar.c);
      closeHistory.push(close);
      trendLine.push(close);
      regimeLine.push(close);
      barIndex += 1;
      if (heldLastBatch && close > peakClose) peakClose = close;
    }
    if (state.warmingUp || lastBar === null) return [];

    const symbol = lastBar.symbol;
    const closeNow = Number(lastBar.c);
    const position = state.positions.get(symbol);

    if (position !== undefined) {
      // First sight of the position: anchor the trailing stop at this close.
      if (!heldLastBatch) {
        anchorClose = closeNow;
        peakClose = closeNow;
      }
      heldLastBatch = true;

      const worthNow = state.value(symbol, position.qty);
      const costBasis = position.cost;

      if (shouldExit(worthNow, costBasis, closeNow)) {
        const sellAll: SellInput = {
          side: 'sell',
          symbol,
          qty: position.qty,
          max_slippage_bps: SLIPPAGE_CAP_BPS,
        };
        return [sellAll];
      }
      return [];
    }

    // Flat. If a position just disappeared, an exit filled: start resting.
    if (heldLastBatch) {
      heldLastBatch = false;
      restWaited = 0;
      anchorClose = 0;
      peakClose = 0;
    } else if (restWaited < REST_BARS) {
      restWaited += 1;
    }

    // Entry gate: rested, inside the entry window, regime up, and the last
    // two hours of travel already exceed what a round trip costs.
    const momentum = trailingMomentum();
    const canEnter =
      restWaited >= REST_BARS &&
      barIndex <= ENTRY_DEADLINE_BAR &&
      momentum !== null &&
      momentum >= MOMENTUM_FLOOR &&
      regimeIsUp(closeNow);
    if (!canEnter) return [];

    let stake = (state.equity * STAKE_BPS) / BPS;
    if (stake > state.cash) stake = state.cash;
    if (stake < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    if (state.hello.caps.max_orders_per_bar < 1) return [];

    const buy: BuyInput = {
      side: 'buy',
      symbol,
      notional_quote_units: stake,
      max_slippage_bps: SLIPPAGE_CAP_BPS,
    };
    return [buy];
  },
});
