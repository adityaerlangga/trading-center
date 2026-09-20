import { randomUUID } from "node:crypto";
import { loadBinanceFees, type FeeBook } from "../market/fees";
import { fetchKlinesBatch } from "../market/rest";
import { fetchTopUsdtByVolume } from "../market/universe";
import { getStrategy } from "../strategies/index";
import { saveExperiment } from "../storage/experiments";
import type { Candle } from "../types";
import { aggregateMetrics, scoreRun, type ResearchMetrics } from "./metrics";
import { btcReturnPct, simulateWindow } from "./simulate";

const HOUR = 60 * 60 * 1000;
const TRAIN_HOURS = 24 * 30;
const TEST_HOURS = 24 * 7;
const STEP_HOURS = 24 * 7;

export type ResearchReport = {
  id: string;
  strategy: string;
  interval: string;
  symbols: string[];
  folds: ResearchMetrics[];
  aggregate: ResearchMetrics;
  passed: boolean;
};

export async function runResearch(opts: {
  strategy: string;
  interval?: string;
  limit?: number;
  fees?: FeeBook;
  persist?: boolean;
}): Promise<ResearchReport> {
  const interval = opts.interval ?? "1h";
  const symbols = await fetchTopUsdtByVolume(opts.limit ?? 24);
  const fees = opts.fees ?? (await loadBinanceFees());
  const candles = await fetchKlinesBatch(symbols, interval, 1000);
  const strategy = getStrategy(opts.strategy);
  const btc = candles.BTCUSDT ?? [];
  const folds = walkFolds(btc.length).map((fold, index) => {
    const sim = simulateWindow({
      symbols,
      candles,
      from: fold.from,
      to: fold.to,
      strategy: strategy.name,
      fees,
      starting: 1000,
      allocPct: 0.2,
      interval,
    });
    const metrics = scoreRun({
      equity: sim.equity,
      trades: sim.trades,
      starting: 1000,
      btcReturnPct: btcReturnPct(btc, fold.from, fold.to),
    });
    return { index, metrics };
  });
  const aggregate = aggregateMetrics(folds.map((fold) => fold.metrics));
  const report: ResearchReport = {
    id: randomUUID(),
    strategy: strategy.name,
    interval,
    symbols,
    folds: folds.map((fold) => fold.metrics),
    aggregate,
    passed: aggregate.passed,
  };
  if (opts.persist !== false) {
    await saveExperiment(report);
  }
  return report;
}

function walkFolds(length: number) {
  const folds: { from: number; to: number }[] = [];
  if (length < TRAIN_HOURS + 48) {
    const from = Math.max(0, length - TEST_HOURS);
    if (length - from > 48) folds.push({ from, to: length });
    return folds;
  }
  for (let start = 0; start + TRAIN_HOURS + TEST_HOURS <= length; start += STEP_HOURS) {
    folds.push({ from: start + TRAIN_HOURS, to: start + TRAIN_HOURS + TEST_HOURS });
    if (folds.length >= 3) break;
  }
  return folds;
}

export function foldSpanHours(candles: Candle[]) {
  if (candles.length < 2) return 0;
  return (candles[candles.length - 1].closeTime - candles[0].openTime) / HOUR;
}
