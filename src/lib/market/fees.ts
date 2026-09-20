import { createHmac } from "node:crypto";

/** Official Binance Spot VIP 0 taker/maker. Market orders are taker. */
export const BINANCE_VIP0_TAKER = 0.001;

/**
 * PMK 50/2025 PPh 22 final on a crypto sale through a foreign platform.
 * This desk trades on Binance.com, which is not an Indonesian PAKD, so the rate is 1% of sell notional.
 */
export const PPH22_FOREIGN_SELL = 0.01;
const BNB_DISCOUNT = 0.25;

export type FeeSource = "binance_account" | "binance_vip0";

export type FeeBook = {
  source: FeeSource;
  label: string;
  fetchedAt: number;
  defaultTaker: number;
  bySymbol: Record<string, number>;
};

type TradeFeeRow = {
  symbol: string;
  makerCommission: string;
  takerCommission: string;
};

export function emptyFeeBook(): FeeBook {
  return {
    source: "binance_vip0",
    label: feeLabel("binance_vip0", applyBnb(BINANCE_VIP0_TAKER)),
    fetchedAt: 0,
    defaultTaker: applyBnb(BINANCE_VIP0_TAKER),
    bySymbol: {},
  };
}

export function takerFee(book: FeeBook, symbol: string): number {
  return book.bySymbol[symbol.toUpperCase()] ?? book.defaultTaker;
}

export async function loadBinanceFees(): Promise<FeeBook> {
  const keyed = await fetchAccountTradeFees();
  if (keyed) return keyed;
  return emptyFeeBook();
}

async function fetchAccountTradeFees(): Promise<FeeBook | null> {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) return null;

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  const url = `https://api.binance.com/sapi/v1/asset/tradeFee?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Binance tradeFee ${res.status}: ${await res.text()}`);
  }

  const rows = (await res.json()) as TradeFeeRow[];
  const bySymbol: Record<string, number> = {};
  const takers: number[] = [];
  for (const row of rows) {
    const taker = Number(row.takerCommission);
    if (!Number.isFinite(taker)) continue;
    bySymbol[row.symbol] = taker;
    takers.push(taker);
  }
  const defaultTaker =
    bySymbol.BTCUSDT ??
    median(takers) ??
    applyBnb(BINANCE_VIP0_TAKER);

  return {
    source: "binance_account",
    label: feeLabel("binance_account", defaultTaker),
    fetchedAt: Date.now(),
    defaultTaker,
    bySymbol,
  };
}

function applyBnb(rate: number) {
  if (process.env.BINANCE_BNB_FEE === "1") return rate * (1 - BNB_DISCOUNT);
  return rate;
}

function feeLabel(source: FeeSource, taker: number) {
  const pct = `${(taker * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
  if (source === "binance_account") return `Binance account taker ${pct}`;
  if (process.env.BINANCE_BNB_FEE === "1") return `Binance VIP0 taker ${pct} (BNB -25%)`;
  return `Binance VIP0 taker ${pct}`;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
