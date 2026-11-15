// K1 recovery-breakout bot for the btc-race-24h competition.
// It stays in cash through falling markets and buys only 60-minute breakouts
// confirmed by a strong 240-minute move; it exits on a hard stop, trailing stop,
// or break of the 60-minute low.
import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BREAKOUT = 60;
const LOOKBACK_RETURN = 240;
const BREAKOUT_NUMERATOR = 1000n;
const BREAKOUT_DENOMINATOR = 1001n;
const RETURN_DOWN_NUMERATOR = 100n;
const RETURN_DOWN_DENOMINATOR = 99n;
const RETURN_UP_NUMERATOR = 1000n;
const RETURN_UP_DENOMINATOR = 1005n;
const HARD_STOP_NUMERATOR = 1000n;
const HARD_STOP_DENOMINATOR = 996n;
const TRAIL_STOP_NUMERATOR = 1000n;
const TRAIL_STOP_DENOMINATOR = 995n;
const MAX_SLIPPAGE_BPS = 500;

const closes: bigint[] = [];
let entryPrice: bigint | null = null;
let peakSinceEntry: bigint | null = null;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((candidate) => candidate.symbol === SYMBOL);
    if (bar) closes.push(BigInt(bar.c));

    // Fills arrive on the next batch because decisions at t execute at the next bar's open.
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entryPrice = BigInt(fill.price);
        peakSinceEntry = entryPrice;
      }
    }

    const position = state.positions.get(SYMBOL);
    const isLong = position !== undefined && position.qty > 0n;
    const currentClose = bar ? BigInt(bar.c) : null;

    if (isLong && currentClose !== null && peakSinceEntry !== null) {
      if (currentClose > peakSinceEntry) peakSinceEntry = currentClose;
    } else if (!isLong) {
      entryPrice = null;
      peakSinceEntry = null;
    }

    if (state.warmingUp || currentClose === null) return [];

    const hasSixtyPriorCloses = closes.length > LOOKBACK_BREAKOUT;
    let high60 = 0n;
    let low60: bigint | null = null;
    if (hasSixtyPriorCloses) {
      const start = closes.length - 1 - LOOKBACK_BREAKOUT;
      for (let index = start; index < closes.length - 1; index += 1) {
        const close = closes[index];
        if (close > high60) high60 = close;
        if (low60 === null || close < low60) low60 = close;
      }
    }

    if (isLong) {
      if (entryPrice === null || peakSinceEntry === null || !hasSixtyPriorCloses) return [];

      // Each exit sells the full position; the first true condition triggers the sale.
      // Integer cross-multiplication keeps all price thresholds exact.
      const hardStop = currentClose * HARD_STOP_NUMERATOR <= entryPrice * HARD_STOP_DENOMINATOR;
      const trailingStop = currentClose * TRAIL_STOP_NUMERATOR <= peakSinceEntry * TRAIL_STOP_DENOMINATOR;
      const brokeLow = low60 !== null && currentClose < low60;

      if (hardStop || trailingStop || brokeLow) {
        return [{ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Entry needs a full previous 60-bar range and a close 240 bars back.
    if (state.cash <= 0n || !hasSixtyPriorCloses || closes.length <= LOOKBACK_RETURN) return [];
    const ref240 = closes[closes.length - 1 - LOOKBACK_RETURN];
    const breakout = currentClose * BREAKOUT_NUMERATOR > high60 * BREAKOUT_DENOMINATOR;
    const downReturn = currentClose * RETURN_DOWN_NUMERATOR < ref240 * RETURN_DOWN_DENOMINATOR;
    const upReturn = currentClose * RETURN_UP_NUMERATOR > ref240 * RETURN_UP_DENOMINATOR;

    if (breakout && (downReturn || upReturn)) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
