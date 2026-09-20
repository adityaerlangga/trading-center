export type SpeedSample = {
  id: string;
  strategy: string;
  interval: string;
  params: Record<string, number>;
};

const INTERVALS = ["1m", "3m", "5m", "15m"];
const START_DELAYS = [0, 1, 2, 4, 8, 16];

const SHORT: Record<string, string> = {
  tsmom_atr: "tsmom",
  sma_crossover: "sma",
  rsi_mean_reversion: "rsi",
  xs_momentum: "xs",
  dual_momentum: "dual",
  donchian: "don",
  bollinger_revert: "bb",
  connors_rsi2: "rsi2",
  ema_cross: "ema",
  supertrend: "st",
  volume_breakout: "vol",
  pullback: "pb",
  range_fade: "fade",
};

type Variant = { strategy: string; tag: string; params: Record<string, number> };

function variants(): Variant[] {
  const rows: Variant[] = [];
  const add = (strategy: string, tag: string, params: Record<string, number>) => {
    rows.push({ strategy, tag, params });
  };

  for (const lookback of [6, 12, 18, 24, 36, 48]) {
    for (const minMom of [0.002, 0.005, 0.01]) {
      add("tsmom_atr", `lb${lookback}_m${Math.round(minMom * 1000)}`, { lookback, minMom });
    }
  }
  for (const [fast, slow] of [
    [3, 8],
    [5, 13],
    [8, 21],
    [10, 30],
    [12, 26],
    [20, 50],
  ] as const) {
    add("sma_crossover", `${fast}_${slow}`, { fast, slow });
    add("ema_cross", `${fast}_${slow}`, { fast, slow });
    add("pullback", `${fast}_${slow}`, { fast, slow });
  }
  for (const oversold of [15, 20, 25, 30, 35, 40]) {
    for (const exitRsi of [50, 65]) {
      add("rsi_mean_reversion", `os${oversold}_x${exitRsi}`, { oversold, exitRsi });
    }
  }
  for (const lookback of [8, 12, 24, 48]) {
    for (const topDecile of [0.05, 0.1, 0.2]) {
      add("xs_momentum", `lb${lookback}_d${Math.round(topDecile * 100)}`, { lookback, topDecile });
    }
  }
  for (const lookback of [8, 12, 24, 48]) {
    for (const minMom of [0.002, 0.006, 0.012]) {
      add("dual_momentum", `lb${lookback}_m${Math.round(minMom * 1000)}`, { lookback, minMom });
    }
  }
  for (const entry of [8, 12, 20, 30, 40, 55]) {
    add("donchian", `e${entry}`, { entry, exit: Math.max(3, Math.floor(entry / 2)) });
  }
  for (const period of [10, 14, 20, 30]) {
    for (const mult of [1.5, 2, 2.5]) {
      add("bollinger_revert", `p${period}_m${Math.round(mult * 10)}`, { period, mult });
    }
  }
  for (const rsiMax of [3, 5, 10, 15]) {
    for (const trend of [20, 50]) {
      add("connors_rsi2", `r${rsiMax}_t${trend}`, { rsiMax, exitRsi: 65, trend });
    }
  }
  for (const atrPeriod of [7, 10, 14]) {
    for (const atrMult of [2, 3]) {
      add("supertrend", `a${atrPeriod}_m${atrMult * 10}`, { atrPeriod, atrMult });
    }
  }
  for (const entry of [10, 20, 40]) {
    for (const volMult of [1.5, 2.2]) {
      add("volume_breakout", `e${entry}_v${Math.round(volMult * 10)}`, { entry, volMult });
    }
  }
  for (const lookback of [10, 14, 20, 30]) {
    add("range_fade", `lb${lookback}`, { lookback });
  }
  return rows;
}

const GRID = variants();

export function sampleRoster(): SpeedSample[] {
  const rows: SpeedSample[] = [];
  for (const interval of INTERVALS) {
    for (const variant of GRID) {
      for (const startDelay of START_DELAYS) {
        const short = SHORT[variant.strategy] ?? variant.strategy;
        rows.push({
          id: `spd_${interval}_${short}_${variant.tag}_d${startDelay}`,
          strategy: variant.strategy,
          interval,
          params: { ...variant.params, startDelay },
        });
      }
    }
  }
  return rows;
}
