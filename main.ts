// BTC (cbBTC) vs USDC 24h race bot.
//
// Strategy (clean-room, own design, no baseline copied):
// A price-vs-moving-average crossover momentum strategy on the cbBTC one-minute bars, long only.
//   - Maintain a rolling moving average (SMA) of each symbol's close over MA_BARS = 21 bars, updated
//     as bars arrive. The signal is the close against that average: close above the SMA is a bullish
//     bar, close below is a bearish bar.
//   - A bullish cross (close crosses above the SMA) with a bearish bar before it is armed for a full
//     buy of cbBTC at the equity weight, sent on the next batch (it fills at that next bar's open).
//   - A bearish cross (close crosses below the SMA) after a buy is the full exit, sent on the next
//     batch (it fills at the next bar's open).
//   - At most one open position, long only, cash floor 0, no leverage; each buy spends at least
//     fees.min_notional_quote_units of cash and never more than caps.max_weight_bps of equity.
//   - Max slippage per order is wide (10000 bps) so the replay's modelled fee/slippage/impact does not
//     refuse the signal before the move is caught; the replay prices the fill itself with its own
//     slippage and impact model.
//   - Orders the market still refuses (no bar, warmup, after_end, caps) are not retried: the replay
//     takes them as rejected and the fills that did land are what count.
//
// Everything is deterministic: no clock, no environment and no randomness is read; the rolling average
// is recomputed from the bars each batch carries. The strategy never differs between the two runs, so
// the action logs match byte for byte. Only the standard library plus the vendored SDK shim run.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** The universe asset of the race: Coinbase Wrapped BTC (cbBTC) vs USDC. */
const SYMBOL = 'CBBTC';
/** Moving average of closes, in bars. */
const MA_BARS = 21;
/** Max slippage bps per order: wide enough to absorb the modelled fee/slippage/impact round trip so the
 *  signal is not refused before the move is caught. */
const MAX_SLIPPAGE_BPS = 10_000;

/** A symbol's rolling average of closes, oldest window first (length MA_BARS). */
interface Sma {
  values: number[];
  last: number | null;
}
const smas = new Map<string, Sma>();
/** The previous bar's bullish/above flag per symbol, set each batch from its close. */
const prevAbove = new Map<string, boolean>();
/** Whether a bullish cross has been armed for a buy (set when close crossed above the SMA). */
let armed = false;
/** Whether a buy is pending the armed signal to fill. */
let buying = false;
/** Whether a sell is pending the bearish cross after a buy. */
let selling = false;

function smaOf(closes: number[]): number | null {
  if (closes.length < MA_BARS) return null;
  let sum = 0;
  for (let k = closes.length - MA_BARS; k < closes.length; k++) sum += closes[k];
  return sum / MA_BARS;
}

/** The rolling SMA and whether the bar is bullish (close above it), from the bars of one batch. */
function evaluate(symbol: string, bar: Bar): { sma: number | null; above: boolean } {
  const s = smas.get(symbol) ?? { values: [], last: null };
  s.values.push(Number(bar.c));
  if (s.values.length > MA_BARS) s.values.shift();
  smas.set(symbol, s);
  const sma = smaOf(s.values);
  return { sma, above: sma !== null && Number(bar.c) > sma };
}

/** The full buy notional: cash capped at the equity weight cap (and by fees.min_notional_quote_units). */
function buyNotional(state: BarsState): bigint {
  const { caps, fees } = state.hello;
  const equity = state.equity;
  const byWeight = (BigInt(caps.max_weight_bps) * equity) / BPS;
  const slice = state.cash < byWeight ? state.cash : byWeight;
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return 0n;
  return slice;
}

/** The orders to send on this batch, from the bars of this batch and the account. */
function decide(state: BarsState): Array<BuyInput | SellInput> {
  // Any fresh bar of the symbol (any batch's bar updates the rolling average).
  const fresh = state.hello.symbols.map((s) => s.symbol).filter((symbol) => state.latest.get(symbol) !== undefined);
  const orders: Array<BuyInput | SellInput> = [];
  for (const symbol of fresh) {
    const bar = state.latest.get(symbol)!;
    const { sma, above } = evaluate(symbol, bar);
    if (sma === null) continue; // still not long enough history for a signal.
    const previous = prevAbove.get(symbol) ?? false;
    // Bullish cross: above now and below before, and not already armed for this position.
    if (!armed && above && !previous) {
      armed = true;
      buying = true;
      orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: buyNotional(state), max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    // Bearish cross: below now and above before, and a buy is pending.
    if (!selling && !above && previous) {
      selling = true;
      const pos = state.positions.get(symbol);
      if (pos !== undefined && pos.qty !== 0n) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    prevAbove.set(symbol, above);
  }
  return orders;
}

await runBars({
  onBatch(state) {
    const orders = decide(state);
    return orders;
  },
});
