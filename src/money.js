// Decimal-safe money helpers.
// Rule: never do float math on money. All amounts travel as decimal strings
// and are computed with Decimal.js. Postgres stores them as NUMERIC.
const Decimal = require('decimal.js');

Decimal.set({ precision: 36, rounding: Decimal.ROUND_HALF_UP });

const FEE_RATE = new Decimal('0.001'); // 0.1% trading fee
const MAINTENANCE_MARGIN_RATE = new Decimal('0.005'); // 0.5% for liquidation math

const D = (v) => new Decimal(v);

/** fee on a notional value, as a decimal string */
function feeOf(notional) {
  return D(notional).mul(FEE_RATE).toString();
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

module.exports = { D, Decimal, FEE_RATE, MAINTENANCE_MARGIN_RATE, feeOf, liquidationPrice, unrealizedPnl, roe };
