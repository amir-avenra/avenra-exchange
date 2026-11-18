// Trading engine: limit-order matching + futures auto-liquidation.
// Runs on every price tick (see server.js). Pure-ish functions are exported
// for testing (liquidationPrice / unrealizedPnl live in money.js).
const { D, FEE_RATE, unrealizedPnl } = require('./money');

function baseAsset(symbol) {
  return symbol.replace('USDT', '');
}

/**
 * Fill any open limit orders whose price has been reached by the mark price.
 * The exchange itself is the counterparty (simulated infinite liquidity at
 * the Binance mark price). Funds were already locked at order placement:
 *  - buy:  USDT (qty * price * (1 + fee)) was debited
 *  - sell: base qty was debited
 * So a fill only credits the other side.
 */
async function matchLimitOrders(store, prices) {
  const orders = await store.listOpenLimitOrders();
  for (const order of orders) {
    const mark = prices.getPrice(order.symbol);
    if (!mark) continue;
    const reached = order.side === 'buy' ? D(mark).lte(order.price) : D(mark).gte(order.price);
    if (!reached) continue;

    const qty = D(order.qty);
    const price = D(order.price);
    const notional = qty.mul(price);
    const fee = notional.mul(FEE_RATE);
    try {
      if (order.side === 'buy') {
        await store.adjustBalance(order.uid, baseAsset(order.symbol), qty.toString());
      } else {
        await store.adjustBalance(order.uid, 'USDT', notional.minus(fee).toString());
      }
      await store.recordTrade({
        uid: order.uid,
        symbol: order.symbol,
        side: order.side,
        price: price.toString(),
        qty: qty.toString(),
        fee: fee.toString(),
        total: notional.toString(),
      });
      await store.updateSpotOrder(order.id, { status: 'filled', filled_qty: qty.toString() });
      console.log(`[engine] filled limit order #${order.id} ${order.symbol} ${order.side} ${order.qty} @ ${order.price}`);
    } catch (err) {
      console.error(`[engine] failed to fill order #${order.id}:`, err.message);
    }
  }
}

/**
 * Liquidate any open futures position whose mark price crossed its
 * liquidation price. The position closes at the liquidation price; the
 * trader keeps margin + pnl - fee (clamped at >= 0).
 */
async function checkLiquidations(store, prices) {
  const positions = await store.listOpenPositions();
  for (const pos of positions) {
    const mark = prices.getPrice(pos.symbol);
    if (!mark) continue;
    const liq = D(pos.liquidation_price);
    const hit = pos.side === 'long' ? D(mark).lte(liq) : D(mark).gte(liq);
    if (!hit) continue;

    const qty = D(pos.qty);
    const pnl = unrealizedPnl(pos, pos.liquidation_price); // pnl at liq price
    const fee = qty.mul(D(pos.liquidation_price)).mul(FEE_RATE);
    const credit = D(pos.margin).plus(pnl).minus(fee);
    const creditClamped = credit.isNegative() ? D(0) : credit;
    try {
      if (creditClamped.gt(0)) {
        await store.adjustBalance(pos.uid, 'USDT', creditClamped.toString());
      }
      await store.updatePosition(pos.id, {
        status: 'liquidated',
        realized_pnl: pnl.minus(fee).toString(),
        closed_at: new Date().toISOString(),
      });
      console.log(`[engine] LIQUIDATED position #${pos.id} ${pos.symbol} ${pos.side} @ ${pos.liquidation_price}`);
    } catch (err) {
      console.error(`[engine] failed to liquidate position #${pos.id}:`, err.message);
    }
  }
}

async function run(store, prices) {
  await matchLimitOrders(store, prices);
  await checkLiquidations(store, prices);
}

module.exports = { baseAsset, matchLimitOrders, checkLiquidations, run };
