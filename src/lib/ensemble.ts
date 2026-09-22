import type { AgentRuntime, EquityPoint } from "./types";

export type ChampionPick = {
  paperId: string;
  strategy: string;
  interval: string;
  params: Record<string, number>;
  score: number;
  recentPct: number;
  pnlPct: number;
  sharpe: number;
  tradeCount: number;
};

const WINDOW_MS = 24 * 60 * 60_000;
const MIN_AGE_MS = 6 * 60 * 60_000;

/** Recent equity return over ~24h; falls back to full pnl if series is short. */
export function recentEquityPct(series: EquityPoint[], startingUsdt: number, now = Date.now()) {
  if (!series.length) return 0;
  const latest = series[series.length - 1];
  const cutoff = now - WINDOW_MS;
  let baseline = series[0];
  for (const point of series) {
    if (point.ts <= cutoff) baseline = point;
    else break;
  }
  const startEquity = baseline.equity > 0 ? baseline.equity : startingUsdt;
  if (!(startEquity > 0)) return 0;
  return ((latest.equity - startEquity) / startEquity) * 100;
}

export function scorePaperAgent(input: {
  agent: AgentRuntime;
  equity: EquityPoint[];
  tradeCount: number;
  sharpe: number;
  pnlPct: number;
  now?: number;
}): ChampionPick | null {
  const now = input.now ?? Date.now();
  if (input.agent.status === "killed") return null;
  if (now - (input.agent.bornAt || now) < MIN_AGE_MS) return null;
  if (input.tradeCount < 1) return null;

  const recentPct = recentEquityPct(input.equity, input.agent.startingUsdt, now);
  // Prefer agents that made money recently; mild boost for lifetime pnl/sharpe.
  const score = recentPct * 1.2 + input.pnlPct * 0.25 + input.sharpe * 2;
  if (!(score > 0) && !(recentPct > 0)) return null;

  const { strategy, interval, params } = input.agent;
  return {
    paperId: input.agent.id,
    strategy,
    interval: interval || "5m",
    params: { ...params },
    score,
    recentPct,
    pnlPct: input.pnlPct,
    sharpe: input.sharpe,
    tradeCount: input.tradeCount,
  };
}

export function pickChampion(candidates: ChampionPick[]): ChampionPick | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.score - a.score)[0] ?? null;
}
