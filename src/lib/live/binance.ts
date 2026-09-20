import { createHmac } from "node:crypto";

const BASE = "https://api.binance.com";

export type SpotBalance = {
  asset: string;
  free: number;
  locked: number;
};

export type SymbolFilters = {
  symbol: string;
  minQty: number;
  stepSize: number;
  minNotional: number;
};

export type MarketOrderResult = {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  price: number;
  fee: number;
  feeAsset: string;
  fills: Array<{ price: number; qty: number; commission: number; commissionAsset: string }>;
};

function realKeys() {
  const apiKey = process.env.BINANCE_API_KEY_REAL?.trim();
  const secret = process.env.BINANCE_API_SECRET_REAL?.trim();
  if (!apiKey || !secret) {
    throw new Error("BINANCE_API_KEY_REAL / BINANCE_API_SECRET_REAL belum di-set");
  }
  return { apiKey, secret };
}

async function signed(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined> = {},
) {
  const { apiKey, secret } = realKeys();
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    qs.set(key, String(value));
  }
  qs.set("timestamp", String(Date.now()));
  qs.set("recvWindow", "10000");
  qs.set("signature", createHmac("sha256", secret).update(qs.toString()).digest("hex"));
  const res = await fetch(`${BASE}${path}?${qs}`, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { msg: text };
  }
  if (!res.ok) {
    const err = body as { code?: number; msg?: string };
    throw new Error(err.msg ? `Binance ${err.code ?? res.status}: ${err.msg}` : `Binance HTTP ${res.status}`);
  }
  return body;
}

export async function fetchSpotBalances(): Promise<SpotBalance[]> {
  const acct = (await signed("GET", "/api/v3/account")) as {
    balances: Array<{ asset: string; free: string; locked: string }>;
  };
  return (acct.balances ?? [])
    .map((row) => ({
      asset: row.asset,
      free: Number(row.free),
      locked: Number(row.locked),
    }))
    .filter((row) => row.free > 0 || row.locked > 0);
}

export async function fetchSpotUsdtFree(): Promise<number> {
  const balances = await fetchSpotBalances();
  return balances.find((row) => row.asset === "USDT")?.free ?? 0;
}

const filterCache = new Map<string, SymbolFilters>();

export async function getSymbolFilters(symbol: string): Promise<SymbolFilters> {
  const key = symbol.toUpperCase();
  const cached = filterCache.get(key);
  if (cached) return cached;
  const info = (await fetch(`${BASE}/api/v3/exchangeInfo?symbol=${key}`, { cache: "no-store" }).then((r) =>
    r.json(),
  )) as {
    symbols: Array<{
      symbol: string;
      filters: Array<Record<string, string>>;
    }>;
  };
  const row = info.symbols?.[0];
  if (!row) throw new Error(`Symbol ${key} tidak ditemukan di Binance`);
  const lot = row.filters.find((f) => f.filterType === "LOT_SIZE");
  const notional =
    row.filters.find((f) => f.filterType === "NOTIONAL") ??
    row.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  const filters: SymbolFilters = {
    symbol: key,
    minQty: Number(lot?.minQty ?? 0),
    stepSize: Number(lot?.stepSize ?? 0),
    minNotional: Number(notional?.minNotional ?? notional?.notional ?? 5),
  };
  filterCache.set(key, filters);
  return filters;
}

function floorToStep(qty: number, step: number) {
  if (!(step > 0)) return qty;
  const precision = Math.max(0, Math.round(-Math.log10(step)));
  const floored = Math.floor(qty / step) * step;
  return Number(floored.toFixed(precision));
}

function roundQuote(value: number) {
  return Math.floor(value * 100) / 100;
}

export async function placeMarketBuyQuote(symbol: string, quoteUsdt: number): Promise<MarketOrderResult> {
  const filters = await getSymbolFilters(symbol);
  const quote = roundQuote(quoteUsdt);
  if (!(quote >= filters.minNotional)) {
    throw new Error(`${symbol}: quote ${quote} USDT di bawah minNotional ${filters.minNotional}`);
  }
  const raw = (await signed("POST", "/api/v3/order", {
    symbol: symbol.toUpperCase(),
    side: "BUY",
    type: "MARKET",
    quoteOrderQty: quote,
    newOrderRespType: "FULL",
  })) as OrderResponse;
  return normalizeOrder(raw);
}

export async function placeMarketSellQty(symbol: string, qty: number): Promise<MarketOrderResult> {
  const filters = await getSymbolFilters(symbol);
  const quantity = floorToStep(qty, filters.stepSize);
  if (!(quantity >= filters.minQty) || quantity <= 0) {
    throw new Error(`${symbol}: qty ${qty} tidak lolos LOT_SIZE (min ${filters.minQty}, step ${filters.stepSize})`);
  }
  const raw = (await signed("POST", "/api/v3/order", {
    symbol: symbol.toUpperCase(),
    side: "SELL",
    type: "MARKET",
    quantity,
    newOrderRespType: "FULL",
  })) as OrderResponse;
  return normalizeOrder(raw);
}

type OrderResponse = {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  executedQty: string;
  cummulativeQuoteQty: string;
  fills?: Array<{
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
  }>;
};

function normalizeOrder(raw: OrderResponse): MarketOrderResult {
  const fills = (raw.fills ?? []).map((fill) => ({
    price: Number(fill.price),
    qty: Number(fill.qty),
    commission: Number(fill.commission),
    commissionAsset: fill.commissionAsset,
  }));
  const qty = Number(raw.executedQty);
  const quote = Number(raw.cummulativeQuoteQty);
  const price = qty > 0 ? quote / qty : fills[0]?.price ?? 0;
  const fee = fills.reduce((sum, fill) => sum + fill.commission, 0);
  const feeAsset = fills[0]?.commissionAsset ?? "USDT";
  return {
    orderId: raw.orderId,
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    side: raw.side,
    qty,
    price,
    fee,
    feeAsset,
    fills,
  };
}
