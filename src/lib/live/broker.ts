import { baseAsset } from "../config";
import { roundQty, roundUsd } from "../paper/math";
import type { Side, Trade } from "../types";
import { placeMarketBuyQuote, placeMarketSellQty } from "./binance";

export type LivePortfolio = {
  usdt: number;
  holdings: Record<string, number>;
};

/** Place a real Spot market order and update the local portfolio mirror. */
export async function executeLiveMarket(opts: {
  agentId: string;
  symbol: string;
  side: Side;
  feeRate: number;
  portfolio: LivePortfolio;
  sizePct?: number;
}): Promise<Trade | null> {
  const { agentId, symbol, side, feeRate, portfolio } = opts;
  const sizePct = opts.sizePct ?? 1;
  const asset = baseAsset(symbol);

  if (side === "BUY") {
    const budget = roundUsd(portfolio.usdt * sizePct);
    if (!(budget >= 5)) return null;
    const order = await placeMarketBuyQuote(symbol, budget);
    if (!(order.qty > 0) || !(order.price > 0)) return null;
    const notional = order.qty * order.price;
    const feeUsdt =
      order.feeAsset === "USDT"
        ? order.fee
        : order.feeAsset === asset
          ? order.fee * order.price
          : notional * feeRate;
    const cost = roundUsd(notional + (order.feeAsset === "USDT" ? feeUsdt : 0));
    // quoteOrderQty already spent USDT; prefer depleting by quote spent
    const spent = roundUsd(Number.isFinite(notional) ? notional + (order.feeAsset === "USDT" ? order.fee : 0) : budget);
    portfolio.usdt = roundUsd(Math.max(0, portfolio.usdt - Math.min(spent, budget + 1)));
    const receivedQty =
      order.feeAsset === asset ? roundQty(order.qty - order.fee) : roundQty(order.qty);
    portfolio.holdings[asset] = roundQty((portfolio.holdings[asset] ?? 0) + receivedQty);
    return {
      id: crypto.randomUUID(),
      agentId,
      symbol,
      side,
      qty: receivedQty,
      price: order.price,
      fee: roundUsd(feeUsdt),
      feeRate,
      ts: Date.now(),
    };
  }

  const available = portfolio.holdings[asset] ?? 0;
  const qty = roundQty(available * sizePct);
  if (!(qty > 0)) return null;
  const order = await placeMarketSellQty(symbol, qty);
  if (!(order.qty > 0) || !(order.price > 0)) return null;
  const notional = order.qty * order.price;
  const feeUsdt =
    order.feeAsset === "USDT" ? order.fee : order.feeAsset === asset ? order.fee * order.price : notional * feeRate;
  const proceeds = roundUsd(notional - (order.feeAsset === "USDT" ? feeUsdt : 0));
  portfolio.holdings[asset] = roundQty(available - order.qty);
  if (portfolio.holdings[asset] <= 0) delete portfolio.holdings[asset];
  portfolio.usdt = roundUsd(portfolio.usdt + proceeds);
  return {
    id: crypto.randomUUID(),
    agentId,
    symbol,
    side,
    qty: order.qty,
    price: order.price,
    fee: roundUsd(feeUsdt),
    feeRate,
    ts: Date.now(),
  };
}
