import type { Candle, Signal } from "../types";
import { holdingQty, type Portfolio } from "../paper/broker";
import { atr, avgVolume, chandelierStop, highestHigh, lookbackReturn, lowestLow, rsi, sma } from "./indicators";
import { extraStrategies } from "./pack";

export type StrategyContext = {
  candles: Candle[];
  higher?: Candle[];
  portfolio: Portfolio;
  symbol: string;
  params: Record<string, number>;
  rank?: number;
  universeSize?: number;
  btcReturn?: number;
  regime?: "trend" | "chop";
};

export type StrategyDecision = {
  signal: Signal;
  sizePct?: number;
  score?: number;
  reason: string;
};

export type Strategy = {
  name: string;
  label: string;
  note: string;
  scanner: boolean;
  allowsChop?: boolean;
  defaults: Record<string, number>;
  decide: (ctx: StrategyContext) => StrategyDecision;
};

const FEE_ROUNDTRIP = 0.002;

const tsmomAtr: Strategy = {
  name: "tsmom_atr",
  label: "TSMOM + ATR stop",
  note: "Moskowitz, Ooi & Pedersen (JFE 2012) time-series momentum + Wilder ATR chandelier exit. Tahan cash sampai momentum dan volume lolos.",
  scanner: true,
  defaults: {
    lookback: 48,
    sma: 50,
    atrPeriod: 14,
    chanLookback: 22,
    atrMult: 2.5,
    minMom: 0.015,
    minVolRatio: 1.25,
    maxAtrPct: 0.06,
    minAtrPct: 0.0025,
    minScore: 0.015,
  },
  decide({ candles, portfolio, symbol, params }) {
    const lookback = params.lookback ?? 48;
    const smaLen = params.sma ?? 50;
    const minMom = params.minMom ?? 0.015;
    const minVolRatio = params.minVolRatio ?? 1.25;
    const maxAtrPct = params.maxAtrPct ?? 0.06;
    const minAtrPct = params.minAtrPct ?? 0.0025;
    const closes = candles.map((candle) => candle.close);
    const close = closes.at(-1);
    const trend = sma(closes, smaLen);
    const prevTrend = sma(closes.slice(0, -1), smaLen);
    const mom = lookbackReturn(closes, lookback);
    const vol = candles.at(-1)?.volume ?? 0;
    const volAvg = avgVolume(candles, 20);
    const atrVal = atr(candles, params.atrPeriod ?? 14);
    const stop = chandelierStop(
      candles,
      params.atrPeriod ?? 14,
      params.chanLookback ?? 22,
      params.atrMult ?? 2.5,
    );
    const hasPos = holdingQty(portfolio, symbol) > 0;

    if (close == null || trend == null || mom == null || atrVal == null) {
      return {
        signal: "HOLD",
        reason: `${symbol}: data belum cukup untuk TSMOM/ATR (butuh ~${Math.max(lookback, smaLen) + 1} candle)`,
      };
    }

    const atrPct = atrVal / close;
    const volRatio = volAvg && volAvg > 0 ? vol / volAvg : 0;
    const slopeUp = prevTrend != null && trend > prevTrend;
    const score = mom * Math.max(volRatio, 0.5);

    if (hasPos) {
      if (stop != null && close < stop) {
        return {
          signal: "SELL",
          score,
          reason: `${symbol}: chandelier ATR stop — harga ${close.toFixed(6)} < ${stop.toFixed(6)} (Wilder)`,
        };
      }
      if (mom < 0 || close < trend) {
        return {
          signal: "SELL",
          score,
          reason: `${symbol}: TSMOM mati — ret ${pct(mom)} / harga di bawah SMA${smaLen}, keluar`,
        };
      }
      return {
        signal: "HOLD",
        score,
        reason: `${symbol}: momentum ${pct(mom)} masih hidup, tahan. Stop ${stop?.toFixed(6) ?? "—"}`,
      };
    }

    if (mom < minMom) {
      return {
        signal: "HOLD",
        score: mom,
        reason: `${symbol}: TSMOM ${pct(mom)} < ${pct(minMom)} — belum cukup kuat, hold cash`,
      };
    }
    if (close <= trend || !slopeUp) {
      return {
        signal: "HOLD",
        score: mom,
        reason: `${symbol}: harga belum di atas SMA${smaLen} yang menanjak (Faber trend filter)`,
      };
    }
    if (volRatio < minVolRatio) {
      return {
        signal: "HOLD",
        score: mom,
        reason: `${symbol}: volume ${volRatio.toFixed(2)}x rata-rata — tanpa konfirmasi, skip`,
      };
    }
    if (atrPct < minAtrPct || atrPct > maxAtrPct) {
      return {
        signal: "HOLD",
        score: mom,
        reason: `${symbol}: ATR ${pct(atrPct)} di luar zona (mati atau terlalu liar)`,
      };
    }
    if (mom < FEE_ROUNDTRIP * 3) {
      return {
        signal: "HOLD",
        score: mom,
        reason: `${symbol}: edge ${pct(mom)} tidak menutup 3x fee bolak-balik`,
      };
    }
    return {
      signal: "BUY",
      score,
      reason: `${symbol}: TSMOM ${pct(mom)} · vol ${volRatio.toFixed(2)}x · SMA${smaLen} naik — setup layak`,
    };
  },
};

const smaCross: Strategy = {
  name: "sma_crossover",
  label: "SMA crossover (filtered)",
  note: "Hanya fresh golden cross + slope SMA lambat naik + gap > fee. Bukan sekadar SMA cepat di atas lambat.",
  scanner: true,
  defaults: {
    fast: 9,
    slow: 21,
    minScore: 0.006,
    atrPeriod: 14,
    chanLookback: 22,
    atrMult: 2.5,
  },
  decide({ candles, portfolio, symbol, params }) {
    const fast = params.fast ?? 9;
    const slow = params.slow ?? 21;
    const closes = candles.map((candle) => candle.close);
    const fastMa = sma(closes, fast);
    const slowMa = sma(closes, slow);
    const prevFast = sma(closes.slice(0, -1), fast);
    const prevSlow = sma(closes.slice(0, -1), slow);
    const close = closes.at(-1);
    const stop = chandelierStop(
      candles,
      params.atrPeriod ?? 14,
      params.chanLookback ?? 22,
      params.atrMult ?? 2.5,
    );
    if (fastMa == null || slowMa == null || prevFast == null || prevSlow == null || close == null) {
      return {
        signal: "HOLD",
        reason: `${symbol}: belum cukup candle (butuh ${slow + 1}, ada ${closes.length})`,
      };
    }

    const hasPos = holdingQty(portfolio, symbol) > 0;
    const gap = (fastMa - slowMa) / slowMa;
    const crossedUp = prevFast <= prevSlow && fastMa > slowMa;
    const crossedDown = prevFast >= prevSlow && fastMa < slowMa;
    const slopeUp = slowMa > prevSlow;
    const label = `SMA${fast} ${fastMa.toFixed(4)} vs SMA${slow} ${slowMa.toFixed(4)}`;

    if (hasPos) {
      if (stop != null && close < stop) {
        return {
          signal: "SELL",
          score: Math.abs(gap),
          reason: `${symbol}: ${label} — chandelier ATR stop, keluar`,
        };
      }
      if (crossedDown || fastMa < slowMa) {
        return {
          signal: "SELL",
          score: Math.abs(gap),
          reason: `${symbol}: ${label} — death cross / tren putus, keluar`,
        };
      }
      return { signal: "HOLD", score: gap, reason: `${symbol}: ${label} — tren masih hidup, tahan` };
    }

    if (!crossedUp) {
      return {
        signal: "HOLD",
        score: gap,
        reason: `${symbol}: ${label} — belum fresh golden cross, hold cash`,
      };
    }
    if (!slopeUp || gap < FEE_ROUNDTRIP * 2) {
      return {
        signal: "HOLD",
        score: gap,
        reason: `${symbol}: ${label} — cross lemah / SMA lambat datar, skip`,
      };
    }
    return {
      signal: "BUY",
      score: gap,
      reason: `${symbol}: ${label} — golden cross + slope naik`,
    };
  },
};

const rsiMean: Strategy = {
  name: "rsi_mean_reversion",
  label: "RSI rebound",
  note: "Wilder RSI: beli saat rebound dari oversold, bukan saat masih jatuh. Keluar di zona tengah atau ATR stop. Boleh main saat BTC chop.",
  scanner: true,
  allowsChop: true,
  defaults: {
    period: 14,
    oversold: 30,
    exitRsi: 55,
    minScore: 2,
    atrPeriod: 14,
    chanLookback: 22,
    atrMult: 2.2,
  },
  decide({ candles, portfolio, symbol, params }) {
    const period = params.period ?? 14;
    const oversold = params.oversold ?? 30;
    const exitRsi = params.exitRsi ?? 55;
    const closes = candles.map((candle) => candle.close);
    const value = rsi(closes, period);
    const prev = rsi(closes.slice(0, -1), period);
    const close = closes.at(-1);
    const stop = chandelierStop(
      candles,
      params.atrPeriod ?? 14,
      params.chanLookback ?? 22,
      params.atrMult ?? 2.2,
    );
    if (value == null || close == null) {
      return {
        signal: "HOLD",
        reason: `${symbol}: belum cukup candle untuk RSI${period}`,
      };
    }

    const hasPos = holdingQty(portfolio, symbol) > 0;
    const rebound = prev != null && prev <= oversold && value > oversold && value < 50;
    const label = `RSI${period} ${value.toFixed(1)}`;

    if (hasPos) {
      if (stop != null && close < stop) {
        return { signal: "SELL", score: value, reason: `${symbol}: ${label} — ATR stop, keluar` };
      }
      if (value >= exitRsi) {
        return {
          signal: "SELL",
          score: value - exitRsi,
          reason: `${symbol}: ${label} kembali ke ${exitRsi}, ambil hasil mean-reversion`,
        };
      }
      return { signal: "HOLD", reason: `${symbol}: ${label} rebound berjalan, tahan` };
    }

    if (!rebound) {
      return {
        signal: "HOLD",
        reason: `${symbol}: ${label} belum rebound dari oversold — jangan catch falling knife`,
      };
    }
    return {
      signal: "BUY",
      score: oversold - (prev ?? value) + 1,
      reason: `${symbol}: ${label} rebound dari oversold (Wilder)`,
    };
  },
};

const xsMomentum: Strategy = {
  name: "xs_momentum",
  label: "Cross-sectional momentum",
  note: "Jegadeesh & Titman: beli desil teratas return lookback, jual kalau ranking jatuh. Butuh pasar trending.",
  scanner: true,
  defaults: { lookback: 24, topDecile: 0.1, exitRank: 0.3, minScore: 0 },
  decide({ candles, portfolio, symbol, params, rank, universeSize }) {
    const lookback = params.lookback ?? 24;
    const mom = lookbackReturn(
      candles.map((candle) => candle.close),
      lookback,
    );
    const hasPos = holdingQty(portfolio, symbol) > 0;
    if (mom == null || rank == null || !universeSize) {
      return { signal: "HOLD", reason: `${symbol}: ranking lintas-pair belum siap` };
    }
    const pctRank = rank / universeSize;
    const top = params.topDecile ?? 0.1;
    const exit = params.exitRank ?? 0.3;
    if (hasPos && (pctRank > exit || mom < 0)) {
      return {
        signal: "SELL",
        score: mom,
        reason: `${symbol}: ranking ${rank}/${universeSize} jatuh dari desil atas, keluar`,
      };
    }
    if (!hasPos && pctRank <= top && mom > 0) {
      return {
        signal: "BUY",
        score: mom,
        reason: `${symbol}: XS momentum rank ${rank}/${universeSize} · ret ${pct(mom)}`,
      };
    }
    return {
      signal: "HOLD",
      score: mom,
      reason: `${symbol}: rank ${rank}/${universeSize} bukan desil atas`,
    };
  },
};

const dualMomentum: Strategy = {
  name: "dual_momentum",
  label: "Dual momentum",
  note: "Antonacci: time-series momentum hanya jika juga mengalahkan BTC. Kalau tidak, cash.",
  scanner: true,
  defaults: {
    lookback: 48,
    sma: 50,
    minMom: 0.01,
    minScore: 0.01,
    atrPeriod: 14,
    chanLookback: 22,
    atrMult: 2.5,
  },
  decide(ctx) {
    const { candles, portfolio, symbol, params, btcReturn = 0 } = ctx;
    const lookback = params.lookback ?? 48;
    const closes = candles.map((candle) => candle.close);
    const close = closes.at(-1);
    const mom = lookbackReturn(closes, lookback);
    const trend = sma(closes, params.sma ?? 50);
    const stop = chandelierStop(candles, params.atrPeriod ?? 14, params.chanLookback ?? 22, params.atrMult ?? 2.5);
    const hasPos = holdingQty(portfolio, symbol) > 0;
    if (mom == null || close == null || trend == null) {
      return { signal: "HOLD", reason: `${symbol}: data dual momentum belum cukup` };
    }
    if (hasPos && ((stop != null && close < stop) || mom < btcReturn || close < trend)) {
      return {
        signal: "SELL",
        score: mom - btcReturn,
        reason: `${symbol}: dual momentum putus vs BTC ${pct(btcReturn)} / stop`,
      };
    }
    if (!hasPos && mom > Math.max(params.minMom ?? 0.01, btcReturn) && close > trend) {
      return {
        signal: "BUY",
        score: mom - btcReturn,
        reason: `${symbol}: dual mom ${pct(mom)} > BTC ${pct(btcReturn)} dan di atas SMA`,
      };
    }
    return {
      signal: "HOLD",
      score: mom - btcReturn,
      reason: `${symbol}: ${pct(mom)} belum mengalahkan BTC ${pct(btcReturn)}`,
    };
  },
};

const donchian: Strategy = {
  name: "donchian",
  label: "Donchian breakout",
  note: "Turtle/Dennis: beli breakout high N, keluar di low N/2.",
  scanner: true,
  defaults: { entry: 20, exit: 10, minScore: 0 },
  decide({ candles, portfolio, symbol, params }) {
    const entry = params.entry ?? 20;
    const exit = params.exit ?? 10;
    const close = candles.at(-1)?.close;
    const prior = candles.slice(0, -1);
    const high = highestHigh(prior, entry);
    const low = lowestLow(prior, exit);
    const hasPos = holdingQty(portfolio, symbol) > 0;
    if (close == null || high == null || low == null) {
      return { signal: "HOLD", reason: `${symbol}: Donchian butuh ${entry + 1} candle` };
    }
    if (hasPos && close < low) {
      return { signal: "SELL", score: high - close, reason: `${symbol}: Donchian exit, close < low ${exit}` };
    }
    if (!hasPos && close > high) {
      return {
        signal: "BUY",
        score: (close - high) / high,
        reason: `${symbol}: breakout high ${entry} (${high.toFixed(6)})`,
      };
    }
    return { signal: "HOLD", reason: `${symbol}: di dalam kanal Donchian ${entry}/${exit}` };
  },
};

const registry: Record<string, Strategy> = {
  [tsmomAtr.name]: tsmomAtr,
  [xsMomentum.name]: xsMomentum,
  [dualMomentum.name]: dualMomentum,
  [donchian.name]: donchian,
  [smaCross.name]: smaCross,
  [rsiMean.name]: rsiMean,
};

for (const extra of extraStrategies) {
  registry[extra.name] = extra;
}

export function getStrategy(name: string): Strategy {
  const strategy = registry[name];
  if (!strategy) {
    throw new Error(`Unknown strategy: ${name}`);
  }
  return strategy;
}

export function listScannerStrategies() {
  return Object.values(registry)
    .filter((strategy) => strategy.scanner)
    .map((strategy) => ({
      name: strategy.name,
      label: strategy.label,
      note: strategy.note,
      defaults: strategy.defaults,
    }));
}

export function runDecision(strategy: Strategy, ctx: StrategyContext): StrategyDecision {
  const decision = strategy.decide(ctx);
  const flat = holdingQty(ctx.portfolio, ctx.symbol) === 0;
  if (ctx.regime === "chop" && decision.signal === "BUY" && flat && !strategy.allowsChop) {
    return {
      signal: "HOLD",
      score: decision.score,
      reason: `${ctx.symbol}: regime chop — BTC di bawah SMA naik, hold cash. (${decision.reason})`,
    };
  }
  return decision;
}

function pct(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}
