export type SpeedSample = {
  id: string;
  strategy: string;
  interval: string;
  params: Record<string, number>;
};

/** Keep the paper league small enough that the web desk stays responsive. */
const INTERVALS = ["5m", "15m"];
const START_DELAYS = [0, 4];

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

  for (const lookback of [12, 24, 48]) {
    for (const minMom of [0.005, 0.01]) {
      add("tsmom_atr", `lb${lookback}_m${Math.round(minMom * 1000)}`, { lookback, minMom });
    }
  }
  for (const [fast, slow] of [
    [5, 13],
    [8, 21],
    [12, 26],
  ] as const) {
    add("sma_crossover", `${fast}_${slow}`, { fast, slow });
    add("ema_cross", `${fast}_${slow}`, { fast, slow });
    add("pullback", `${fast}_${slow}`, { fast, slow });
  }
  for (const oversold of [20, 30, 35]) {
    add("rsi_mean_reversion", `os${oversold}_x55`, { oversold, exitRsi: 55 });
  }
  for (const lookback of [12, 24]) {
    add("xs_momentum", `lb${lookback}_d10`, { lookback, topDecile: 0.1 });
    add("dual_momentum", `lb${lookback}_m6`, { lookback, minMom: 0.006 });
  }
  for (const entry of [12, 20, 40]) {
    add("donchian", `e${entry}`, { entry, exit: Math.max(3, Math.floor(entry / 2)) });
  }
  for (const period of [14, 20]) {
    add("bollinger_revert", `p${period}_m20`, { period, mult: 2 });
  }
  for (const rsiMax of [5, 10]) {
    add("connors_rsi2", `r${rsiMax}_t50`, { rsiMax, exitRsi: 65, trend: 50 });
  }
  for (const atrPeriod of [10, 14]) {
    add("supertrend", `a${atrPeriod}_m30`, { atrPeriod, atrMult: 3 });
  }
  for (const entry of [10, 20, 40]) {
    for (const volMult of [1.5, 2.2]) {
      add("volume_breakout", `e${entry}_v${Math.round(volMult * 10)}`, { entry, volMult });
    }
  }
  for (const lookback of [14, 20]) {
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
