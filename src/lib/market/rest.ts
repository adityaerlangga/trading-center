import type { BookTicker, Candle } from "../types";
import { REST_HOSTS } from "./hosts";

type KlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  ...unknown[],
];

export async function fetchKlines(
  symbol: string,
  interval: string,
  limit = 200,
): Promise<Candle[]> {
  let lastError: Error | undefined;

  for (const host of REST_HOSTS) {
    const url = new URL("/api/v3/klines", host);
    url.searchParams.set("symbol", symbol.toUpperCase());
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`${host} klines ${res.status}`);
      }
      const rows = (await res.json()) as KlineRow[];
      return rows.map((row) => ({
        openTime: row[0],
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closeTime: row[6],
        isClosed: true,
      }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Failed to fetch klines for ${symbol}`);
}

export async function fetchAllBookTickers(): Promise<BookTicker[]> {
  let lastError: Error | undefined;
  for (const host of REST_HOSTS) {
    const url = new URL("/api/v3/ticker/bookTicker", host);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${host} bookTicker ${res.status}`);
      const rows = (await res.json()) as { symbol: string; bidPrice: string; askPrice: string }[];
      const now = Date.now();
      return rows.map((row) => ({
        symbol: row.symbol,
        bid: Number(row.bidPrice),
        ask: Number(row.askPrice),
        ts: now,
      }));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Failed to fetch book tickers");
}

export async function fetchBookTicker(symbol: string): Promise<BookTicker> {
  let lastError: Error | undefined;

  for (const host of REST_HOSTS) {
    const url = new URL("/api/v3/ticker/bookTicker", host);
    url.searchParams.set("symbol", symbol.toUpperCase());

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`${host} bookTicker ${res.status}`);
      }
      const row = (await res.json()) as { bidPrice: string; askPrice: string };
      return {
        symbol: symbol.toUpperCase(),
        bid: Number(row.bidPrice),
        ask: Number(row.askPrice),
        ts: Date.now(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error(`Failed to fetch bookTicker for ${symbol}`);
}

export async function fetchKlinesBatch(
  symbols: string[],
  interval: string,
  limit = 80,
  onProgress?: (done: number, total: number) => void,
): Promise<Record<string, Candle[]>> {
  const result: Record<string, Candle[]> = {};
  const total = symbols.length;
  let done = 0;
  const queue = [...symbols];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length > 0) {
      const symbol = queue.shift();
      if (!symbol) break;
      try {
        result[symbol] = await fetchKlines(symbol, interval, limit);
      } catch {
        result[symbol] = [];
      }
      done += 1;
      onProgress?.(done, total);
    }
  });
  await Promise.all(workers);
  return result;
}
