import { isPegged } from "../config";
import { REST_HOSTS } from "./hosts";

type ExchangeSymbol = {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
};

type ExchangeInfo = {
  symbols: ExchangeSymbol[];
};

export async function fetchUsdtUniverse(): Promise<string[]> {
  let lastError: Error | undefined;

  for (const host of REST_HOSTS) {
    const url = new URL("/api/v3/exchangeInfo", host);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${host} exchangeInfo ${res.status}`);
      const data = (await res.json()) as ExchangeInfo;
      return data.symbols
        .filter(
          (row) =>
            row.status === "TRADING" &&
            row.quoteAsset === "USDT" &&
            !row.baseAsset.endsWith("UP") &&
            !row.baseAsset.endsWith("DOWN") &&
            !isPegged(row.baseAsset),
        )
        .map((row) => row.symbol)
        .sort();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Failed to load USDT universe");
}

export async function fetchTopUsdtByVolume(limit = 30): Promise<string[]> {
  const allowed = new Set(await fetchUsdtUniverse());
  let lastError: Error | undefined;

  for (const host of REST_HOSTS) {
    const url = new URL("/api/v3/ticker/24hr", host);
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`${host} ticker24hr ${res.status}`);
      const rows = (await res.json()) as { symbol: string; quoteVolume: string }[];
      const ranked = rows
        .filter((row) => allowed.has(row.symbol))
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, limit)
        .map((row) => row.symbol);
      if (!ranked.includes("BTCUSDT")) ranked.unshift("BTCUSDT");
      return ranked.slice(0, limit);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Failed to rank USDT liquidity");
}
