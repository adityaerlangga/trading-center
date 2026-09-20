import type { Candle, Signal } from "../types";
import { holdingQty, type Portfolio } from "../paper/broker";
import { atr, avgVolume, bollinger, chandelierStop, ema, highestHigh, lowestLow, rsi, sma } from "./indicators";

type Ctx = {
  candles: Candle[];
  portfolio: Portfolio;
  symbol: string;
  params: Record<string, number>;
};

type Decision = { signal: Signal; score?: number; reason: string };

export type ExtraStrategy = {
  name: string;
  label: string;
  note: string;
  scanner: boolean;
  allowsChop: boolean;
  defaults: Record<string, number>;
  decide: (ctx: Ctx) => Decision;
};

function supertrendDir(candles: Candle[], period: number, mult: number) {
  if (candles.length < period + 2) return null;
  let dir = 1;
  let prev = 1;
  let band = 0;
  for (let i = period; i < candles.length; i += 1) {
    const value = atr(candles.slice(0, i + 1), period);
    const candle = candles[i];
    if (value == null) continue;
    const mid = (candle.high + candle.low) / 2;
    const upper = mid + mult * value;
    const lower = mid - mult * value;
    prev = dir;
    if (candle.close > (band || upper)) dir = 1;
    else if (candle.close < (band || lower)) dir = -1;
    band = dir === 1 ? Math.max(lower, band || lower) : Math.min(upper, band || upper);
  }
  return { dir, prev };
}

export const extraStrategies: ExtraStrategy[] = [
  {
    name: "bollinger_revert",
    label: "Bollinger revert",
    note: "Bollinger: beli di bawah band, jual di tengah. Sengaja main di pasar chop.",
    scanner: true,
    allowsChop: true,
    defaults: { period: 20, mult: 2, atrPeriod: 14, atrMult: 2.2, chanLookback: 14, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const closes = candles.map((candle) => candle.close);
      const close = closes.at(-1);
      const bands = bollinger(closes, params.period ?? 20, params.mult ?? 2);
      const stop = chandelierStop(candles, params.atrPeriod ?? 14, params.chanLookback ?? 14, params.atrMult ?? 2.2);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      if (!bands || close == null) return { signal: "HOLD", reason: `${symbol}: Bollinger belum cukup data` };
      if (hasPos && (close >= bands.mid || (stop != null && close < stop))) {
        return { signal: "SELL", score: close - bands.mid, reason: `${symbol}: kembali ke mid Bollinger / stop` };
      }
      if (!hasPos && close < bands.lower) {
        return {
          signal: "BUY",
          score: (bands.lower - close) / close,
          reason: `${symbol}: close di bawah lower band ${bands.lower.toFixed(6)}`,
        };
      }
      return { signal: "HOLD", reason: `${symbol}: di dalam Bollinger, tunggu ekstrem` };
    },
  },
  {
    name: "connors_rsi2",
    label: "Connors RSI-2",
    note: "Connors: RSI(2) ekstrem saat harga masih di atas SMA. Entry pendek, sering, untuk kalahkan fee di menit/jam.",
    scanner: true,
    allowsChop: true,
    defaults: { rsiMax: 10, exitRsi: 70, trend: 50, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const closes = candles.map((candle) => candle.close);
      const close = closes.at(-1);
      const value = rsi(closes, 2);
      const trend = sma(closes, params.trend ?? 50);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      const rsiMax = params.rsiMax ?? 10;
      const exitRsi = params.exitRsi ?? 70;
      if (value == null || close == null || trend == null) {
        return { signal: "HOLD", reason: `${symbol}: RSI-2 belum cukup candle` };
      }
      if (hasPos && value >= exitRsi) {
        return { signal: "SELL", score: value, reason: `${symbol}: RSI2 ${value.toFixed(1)} >= ${exitRsi}, ambil` };
      }
      if (hasPos && close < trend) {
        return { signal: "SELL", score: value, reason: `${symbol}: RSI2 putus, harga di bawah SMA` };
      }
      if (!hasPos && value <= rsiMax && close > trend) {
        return {
          signal: "BUY",
          score: rsiMax - value,
          reason: `${symbol}: Connors RSI2 ${value.toFixed(1)} <= ${rsiMax}, harga di atas SMA`,
        };
      }
      return { signal: "HOLD", reason: `${symbol}: RSI2 ${value.toFixed(1)} belum ekstrem` };
    },
  },
  {
    name: "ema_cross",
    label: "EMA cross",
    note: "EMA lebih cepat dari SMA. Hanya fresh cross, bukan sekadar EMA cepat di atas lambat.",
    scanner: true,
    allowsChop: false,
    defaults: { fast: 8, slow: 21, atrPeriod: 14, atrMult: 2.5, chanLookback: 22, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const closes = candles.map((candle) => candle.close);
      const fast = params.fast ?? 8;
      const slow = params.slow ?? 21;
      const fastNow = ema(closes, fast);
      const slowNow = ema(closes, slow);
      const fastPrev = ema(closes.slice(0, -1), fast);
      const slowPrev = ema(closes.slice(0, -1), slow);
      const close = closes.at(-1);
      const stop = chandelierStop(candles, params.atrPeriod ?? 14, params.chanLookback ?? 22, params.atrMult ?? 2.5);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null || close == null) {
        return { signal: "HOLD", reason: `${symbol}: EMA belum cukup data` };
      }
      const up = fastPrev <= slowPrev && fastNow > slowNow;
      const down = fastPrev >= slowPrev && fastNow < slowNow;
      if (hasPos && (down || (stop != null && close < stop))) {
        return { signal: "SELL", reason: `${symbol}: EMA death cross atau ATR stop` };
      }
      if (!hasPos && up) {
        return { signal: "BUY", score: (fastNow - slowNow) / slowNow, reason: `${symbol}: EMA${fast} potong EMA${slow} naik` };
      }
      return { signal: "HOLD", reason: `${symbol}: belum fresh EMA cross` };
    },
  },
  {
    name: "supertrend",
    label: "Supertrend",
    note: "Flip ATR supertrend. Masuk saat arah berubah naik, keluar saat flip turun.",
    scanner: true,
    allowsChop: false,
    defaults: { atrPeriod: 10, atrMult: 3, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const flip = supertrendDir(candles, params.atrPeriod ?? 10, params.atrMult ?? 3);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      if (!flip) return { signal: "HOLD", reason: `${symbol}: supertrend belum cukup data` };
      if (hasPos && flip.dir < 0) return { signal: "SELL", reason: `${symbol}: supertrend flip turun` };
      if (!hasPos && flip.dir > 0 && flip.prev < 0) {
        return { signal: "BUY", score: 1, reason: `${symbol}: supertrend flip naik` };
      }
      if (hasPos) return { signal: "HOLD", reason: `${symbol}: supertrend masih naik` };
      return { signal: "HOLD", reason: `${symbol}: supertrend belum flip` };
    },
  },
  {
    name: "volume_breakout",
    label: "Volume breakout",
    note: "Break high N hanya jika volume ikut. Tanpa volume, skip.",
    scanner: true,
    allowsChop: false,
    defaults: { entry: 20, volMult: 1.8, atrPeriod: 14, atrMult: 2.5, chanLookback: 20, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const close = candles.at(-1)?.close;
      const prior = candles.slice(0, -1);
      const high = highestHigh(prior, params.entry ?? 20);
      const vol = candles.at(-1)?.volume ?? 0;
      const base = avgVolume(candles, 20);
      const stop = chandelierStop(candles, params.atrPeriod ?? 14, params.chanLookback ?? 20, params.atrMult ?? 2.5);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      const ratio = base && base > 0 ? vol / base : 0;
      if (close == null || high == null) return { signal: "HOLD", reason: `${symbol}: breakout belum cukup data` };
      if (hasPos && stop != null && close < stop) return { signal: "SELL", reason: `${symbol}: volume breakout kena ATR stop` };
      if (!hasPos && close > high && ratio >= (params.volMult ?? 1.8)) {
        return {
          signal: "BUY",
          score: ratio,
          reason: `${symbol}: break high ${params.entry ?? 20} + volume ${ratio.toFixed(2)}x`,
        };
      }
      return { signal: "HOLD", reason: `${symbol}: belum breakout bervolume (${ratio.toFixed(2)}x)` };
    },
  },
  {
    name: "pullback",
    label: "Trend pullback",
    note: "Tren naik, beli saat harga menyentuh EMA cepat lalu ditutup di atasnya.",
    scanner: true,
    allowsChop: false,
    defaults: { fast: 20, slow: 50, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const closes = candles.map((candle) => candle.close);
      const close = closes.at(-1);
      const low = candles.at(-1)?.low;
      const fast = ema(closes, params.fast ?? 20);
      const slow = sma(closes, params.slow ?? 50);
      const prevSlow = sma(closes.slice(0, -1), params.slow ?? 50);
      const hasPos = holdingQty(portfolio, symbol) > 0;
      if (close == null || low == null || fast == null || slow == null) {
        return { signal: "HOLD", reason: `${symbol}: pullback belum cukup data` };
      }
      if (hasPos && close < slow) return { signal: "SELL", reason: `${symbol}: pullback gagal, di bawah SMA lambat` };
      const touched = low <= fast && close > fast && close > slow && (prevSlow == null || slow >= prevSlow);
      if (!hasPos && touched) {
        return { signal: "BUY", score: (close - fast) / fast, reason: `${symbol}: pullback ke EMA lalu ditutup naik` };
      }
      return { signal: "HOLD", reason: `${symbol}: belum ada pullback bersih` };
    },
  },
  {
    name: "range_fade",
    label: "Range fade",
    note: "Di range sempit, beli dekat low dan jual di tengah. Lawan dari momentum.",
    scanner: true,
    allowsChop: true,
    defaults: { lookback: 20, minScore: 0 },
    decide({ candles, portfolio, symbol, params }) {
      const lookback = params.lookback ?? 20;
      const prior = candles.slice(0, -1);
      const high = highestHigh(prior, lookback);
      const low = lowestLow(prior, lookback);
      const close = candles.at(-1)?.close;
      const hasPos = holdingQty(portfolio, symbol) > 0;
      if (high == null || low == null || close == null || high <= low) {
        return { signal: "HOLD", reason: `${symbol}: range belum terbentuk` };
      }
      const mid = (high + low) / 2;
      const width = (high - low) / mid;
      if (width > 0.08) return { signal: "HOLD", reason: `${symbol}: range terlalu lebar ${(width * 100).toFixed(1)}%, skip fade` };
      if (hasPos && close >= mid) return { signal: "SELL", score: close - mid, reason: `${symbol}: fade sampai tengah range` };
      if (!hasPos && close <= low + (high - low) * 0.2) {
        return { signal: "BUY", score: mid - close, reason: `${symbol}: dekat low range, fade` };
      }
      return { signal: "HOLD", reason: `${symbol}: belum di tepi range` };
    },
  },
];
