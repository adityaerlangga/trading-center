import type { Candle } from "../types";
import { lookbackReturn, resample, sma } from "../strategies/indicators";

export type Regime = "trend" | "chop";

export type ScanContext = {
  regime: Regime;
  btcReturn: number;
  ranks: Record<string, number>;
  universeSize: number;
};

export function higherBars(interval: string) {
  if (interval === "1h") return 4;
  if (interval === "4h") return 6;
  return 48;
}

export function volTargetWeight(allocPct: number, atrPct: number, target = 0.02) {
  if (!(atrPct > 0)) return allocPct;
  return allocPct * Math.min(1, target / atrPct);
}

export function buildScanContext(
  candles: Record<string, Candle[]>,
  lookback = 24,
): ScanContext {
  const symbols = Object.keys(candles).filter((symbol) => (candles[symbol]?.length ?? 0) > lookback);
  const moms = symbols
    .map((symbol) => ({
      symbol,
      mom: lookbackReturn(
        candles[symbol].map((candle) => candle.close),
        lookback,
      ),
    }))
    .filter((row): row is { symbol: string; mom: number } => row.mom != null)
    .sort((a, b) => b.mom - a.mom);
  const ranks: Record<string, number> = {};
  moms.forEach((row, index) => {
    ranks[row.symbol] = index + 1;
  });
  const btcCloses = (candles.BTCUSDT ?? []).map((candle) => candle.close);
  const btcReturn = lookbackReturn(btcCloses, lookback) ?? 0;
  return {
    regime: btcRegime(candles.BTCUSDT ?? []),
    btcReturn,
    ranks,
    universeSize: Math.max(1, moms.length),
  };
}

export function btcRegime(candles: Candle[]): Regime {
  const closes = candles.map((candle) => candle.close);
  const close = closes.at(-1);
  const trend = sma(closes, 50);
  const prev = sma(closes.slice(0, -1), 50);
  if (close == null || trend == null || prev == null) return "trend";
  return close > trend && trend > prev ? "trend" : "chop";
}

export function higherSeries(candles: Candle[], interval: string) {
  return resample(candles, higherBars(interval));
}
