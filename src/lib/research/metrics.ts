import type { EquityPoint, Trade } from "../types";

export type ResearchMetrics = {
  returnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  profitFactor: number;
  turnover: number;
  trades: number;
  btcReturnPct: number;
  excessVsBtc: number;
  passed: boolean;
  reason: string;
};

const MAX_DD = 15;
const MAX_TURNOVER = 8;

export function sharpeRatio(points: EquityPoint[], periodsPerYear = 24 * 365): number {
  if (points.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].equity;
    if (prev <= 0) continue;
    rets.push(points[i].equity / prev - 1);
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((sum, value) => sum + value, 0) / rets.length;
  const variance = rets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (rets.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(periodsPerYear);
}

export function maxDrawdownPct(points: EquityPoint[]): number {
  let peak = points[0]?.equity ?? 0;
  let worst = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) worst = Math.max(worst, (peak - point.equity) / peak);
  }
  return worst * 100;
}

export function scoreRun(opts: {
  equity: EquityPoint[];
  trades: Trade[];
  starting: number;
  btcReturnPct: number;
}): ResearchMetrics {
  const ending = opts.equity.at(-1)?.equity ?? opts.starting;
  const returnPct = opts.starting === 0 ? 0 : ((ending - opts.starting) / opts.starting) * 100;
  const sharpe = sharpeRatio(opts.equity);
  const drawdown = maxDrawdownPct(opts.equity);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < opts.equity.length; i += 1) {
    const delta = opts.equity[i].equity - opts.equity[i - 1].equity;
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const profitFactor = losses === 0 ? (gains > 0 ? 99 : 0) : gains / losses;
  const bought = opts.trades
    .filter((trade) => trade.side === "BUY")
    .reduce((sum, trade) => sum + trade.qty * trade.price, 0);
  const turnover = opts.starting === 0 ? 0 : bought / opts.starting;
  const excessVsBtc = returnPct - opts.btcReturnPct;
  const ddOk = drawdown <= MAX_DD;
  const turnoverOk = turnover <= MAX_TURNOVER;
  const beatBtc = returnPct > opts.btcReturnPct;
  const gentler = drawdown <= 8 && returnPct > opts.btcReturnPct - 5;
  const passed = ddOk && turnoverOk && (beatBtc || gentler);
  const reason = passed
    ? "lolos: nett vs BTC dan drawdown/turnover aman"
    : [
        !ddOk ? `DD ${drawdown.toFixed(1)}% > ${MAX_DD}%` : "",
        !turnoverOk ? `turnover ${turnover.toFixed(1)}x > ${MAX_TURNOVER}x` : "",
        !(beatBtc || gentler) ? "kalah hold BTC tanpa DD yang jauh lebih kecil" : "",
      ]
        .filter(Boolean)
        .join("; ");

  return {
    returnPct,
    sharpe,
    maxDrawdownPct: drawdown,
    profitFactor,
    turnover,
    trades: opts.trades.length,
    btcReturnPct: opts.btcReturnPct,
    excessVsBtc,
    passed,
    reason: reason || "gagal",
  };
}

export function aggregateMetrics(folds: ResearchMetrics[]): ResearchMetrics {
  if (folds.length === 0) {
    return {
      returnPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      profitFactor: 0,
      turnover: 0,
      trades: 0,
      btcReturnPct: 0,
      excessVsBtc: 0,
      passed: false,
      reason: "tidak ada fold",
    };
  }
  const avg = (pick: (row: ResearchMetrics) => number) =>
    folds.reduce((sum, row) => sum + pick(row), 0) / folds.length;
  const passedCount = folds.filter((row) => row.passed).length;
  const excess = avg((row) => row.excessVsBtc);
  const passed = passedCount > folds.length / 2;
  return {
    returnPct: avg((row) => row.returnPct),
    sharpe: avg((row) => row.sharpe),
    maxDrawdownPct: Math.max(...folds.map((row) => row.maxDrawdownPct)),
    profitFactor: avg((row) => row.profitFactor),
    turnover: avg((row) => row.turnover),
    trades: folds.reduce((sum, row) => sum + row.trades, 0),
    btcReturnPct: avg((row) => row.btcReturnPct),
    excessVsBtc: excess,
    passed,
    reason: passed
      ? `${passedCount}/${folds.length} fold lolos, excess ${excess.toFixed(2)}%`
      : `${passedCount}/${folds.length} fold lolos, excess ${excess.toFixed(2)}% — tidak dipromosikan`,
  };
}
