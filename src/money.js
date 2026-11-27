// Decimal-safe money helpers.
// Rule: never do float math on money. All amounts travel as decimal strings
// and are computed with Decimal.js. Postgres stores them as NUMERIC.
const Decimal = require('decimal.js');

Decimal.set({ precision: 36, rounding: Decimal.ROUND_HALF_UP });

// Trading fees — the KCEX schedule (verified 2026-11-27 against KCEX's
// published fee page and its fee comparison: spot 0% maker/taker,
// futures 0% maker / 0.01% taker). No spread is ever charged: market
// orders execute at the Binance mark price, never at bid/ask +/- spread.
const SPOT_FEE_RATE = new Decimal('0'); // 0% — KCEX spot maker/taker
const FUTURES_MAKER_FEE_RATE = new Decimal('0'); // 0% — KCEX futures maker
const FUTURES_TAKER_FEE_RATE = new Decimal('0.0001'); // 0.01% — KCEX futures taker
const MAINTENANCE_MARGIN_RATE = new Decimal('0.005'); // 0.5% for liquidation math

const D = (v) => new Decimal(v);

/** spot fee on a notional value, as a decimal string (0% on KCEX) */
function spotFeeOf(notional) {
  return D(notional).mul(SPOT_FEE_RATE).toString();
}

/** futures taker fee on a notional value (0.01% on KCEX) */
function futuresTakerFeeOf(notional) {
  return D(notional).mul(FUTURES_TAKER_FEE_RATE).toString();
}

/** futures maker fee on a notional value (0% on KCEX) */
function futuresMakerFeeOf(notional) {
  return D(notional).mul(FUTURES_MAKER_FEE_RATE).toString();
}

/**
 * Estimated liquidation price for an isolated-margin position.
 * Long:  entry * (1 - 1/leverage + mmr)
 * Short: entry * (1 + 1/leverage - mmr)
 * (mmr = maintenance margin rate)
 */
function liquidationPrice(side, entry, leverage) {
  const e = D(entry);
  const inv = D(1).div(leverage);
  if (side === 'long') {
    return e.mul(D(1).minus(inv).plus(MAINTENANCE_MARGIN_RATE)).toString();
  }
  return e.mul(D(1).plus(inv).minus(MAINTENANCE_MARGIN_RATE)).toString();
}

/** Unrealized PnL of an open position at a mark price. Returns Decimal. */
function unrealizedPnl(position, markPrice) {
  const qty = D(position.qty);
  const diff = D(markPrice).minus(position.entry_price);
  return position.side === 'long' ? diff.mul(qty) : diff.neg().mul(qty);
}

/** ROE % = unrealized PnL / margin * 100 */
function roe(position, markPrice) {
  const margin = D(position.margin);
  if (margin.isZero()) return new Decimal(0);
  return unrealizedPnl(position, markPrice).div(margin).mul(100);
}

module.exports = { D, Decimal, SPOT_FEE_RATE, FUTURES_MAKER_FEE_RATE, FUTURES_TAKER_FEE_RATE, MAINTENANCE_MARGIN_RATE, spotFeeOf, futuresTakerFeeOf, futuresMakerFeeOf, liquidationPrice, unrealizedPnl, roe };
