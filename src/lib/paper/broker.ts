import { baseAsset } from "../config";
import type { Side, Trade } from "../types";
import { roundQty, roundUsd } from "./math";

export type Portfolio = {
  usdt: number;
  holdings: Record<string, number>;
};

export function emptyPortfolio(startingUsdt: number): Portfolio {
  return { usdt: startingUsdt, holdings: {} };
}

export function holdingQty(portfolio: Portfolio, symbol: string): number {
  return portfolio.holdings[baseAsset(symbol)] ?? 0;
}

export function executeMarket(opts: {
  agentId: string;
  symbol: string;
  side: Side;
  price: number;
  feeRate: number;
  portfolio: Portfolio;
  sizePct?: number;
}): Trade | null {
  const { agentId, symbol, side, price, feeRate, portfolio } = opts;
  if (!Number.isFinite(price) || price <= 0) return null;

  const asset = baseAsset(symbol);
  const sizePct = opts.sizePct ?? 1;

  if (side === "BUY") {
    const budget = portfolio.usdt * sizePct;
    const qty = roundQty(budget / (price * (1 + feeRate)));
    if (qty <= 0) return null;
    const notional = qty * price;
    const fee = notional * feeRate;
    const cost = notional + fee;
    if (cost > portfolio.usdt + 1e-9) return null;

    portfolio.usdt = roundUsd(portfolio.usdt - cost);
    portfolio.holdings[asset] = roundQty((portfolio.holdings[asset] ?? 0) + qty);

    return {
      id: crypto.randomUUID(),
      agentId,
      symbol,
      side,
      qty,
      price,
      fee: roundUsd(fee),
      feeRate,
      ts: Date.now(),
    };
  }

  const available = portfolio.holdings[asset] ?? 0;
  const qty = roundQty(available * sizePct);
  if (qty <= 0) return null;
  const notional = qty * price;
  const fee = notional * feeRate;
  const proceeds = notional - fee;

  portfolio.holdings[asset] = roundQty(available - qty);
  if (portfolio.holdings[asset] <= 0) {
    delete portfolio.holdings[asset];
  }
  portfolio.usdt = roundUsd(portfolio.usdt + proceeds);

  return {
    id: crypto.randomUUID(),
    agentId,
    symbol,
    side,
    qty,
    price,
    fee: roundUsd(fee),
    feeRate,
    ts: Date.now(),
  };
}
