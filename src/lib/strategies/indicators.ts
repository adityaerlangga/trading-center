import type { Candle } from "../types";

export function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, row) => sum + row, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

export function bollinger(values: number[], period = 20, mult = 2) {
  const mid = sma(values, period);
  if (mid == null) return null;
  const slice = values.slice(-period);
  const variance = slice.reduce((sum, value) => sum + (value - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

export function rsi(values: number[], period = 14): number | null {
  if (period <= 0 || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(candles: Candle[], period = 14): number | null {
  if (period <= 0 || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1].close;
    const candle = candles[i];
    trs.push(Math.max(candle.high - candle.low, Math.abs(candle.high - prev), Math.abs(candle.low - prev)));
  }
  if (trs.length < period) return null;
  let value = trs.slice(0, period).reduce((sum, row) => sum + row, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    value = (value * (period - 1) + trs[i]) / period;
  }
  return value;
}

export function lookbackReturn(closes: number[], lookback: number): number | null {
  if (lookback <= 0 || closes.length < lookback + 1) return null;
  const prev = closes[closes.length - 1 - lookback];
  if (prev <= 0) return null;
  return closes[closes.length - 1] / prev - 1;
}

export function avgVolume(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((sum, candle) => sum + candle.volume, 0) / period;
}

export function highestHigh(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period) return null;
  return Math.max(...candles.slice(-period).map((candle) => candle.high));
}

export function lowestLow(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period) return null;
  return Math.min(...candles.slice(-period).map((candle) => candle.low));
}

export function resample(candles: Candle[], bars: number): Candle[] {
  if (bars <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i + bars <= candles.length; i += bars) {
    const slice = candles.slice(i, i + bars);
    const first = slice[0];
    const last = slice[slice.length - 1];
    out.push({
      openTime: first.openTime,
      open: first.open,
      high: Math.max(...slice.map((candle) => candle.high)),
      low: Math.min(...slice.map((candle) => candle.low)),
      close: last.close,
      volume: slice.reduce((sum, candle) => sum + candle.volume, 0),
      closeTime: last.closeTime,
      isClosed: last.isClosed,
    });
  }
  return out;
}

export function chandelierStop(
  candles: Candle[],
  atrPeriod = 14,
  lookback = 22,
  mult = 2.5,
): number | null {
  const value = atr(candles, atrPeriod);
  const peak = highestHigh(candles, lookback);
  if (value == null || peak == null) return null;
  return peak - mult * value;
}
