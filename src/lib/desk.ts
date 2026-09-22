import type { Mode } from "./types";

export type DeskEnv = Mode;

export function parseDeskEnv(value: string | null | undefined): DeskEnv {
  return value === "live" ? "live" : "paper";
}

export function liveKeysConfigured() {
  return Boolean(process.env.BINANCE_API_KEY_REAL?.trim() && process.env.BINANCE_API_SECRET_REAL?.trim());
}

export function liveBudgetUsdt() {
  const raw = Number(process.env.LIVE_BUDGET_USDT ?? 100);
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return raw;
}

export type LiveAgentSpec = {
  id: string;
  strategy: string;
  interval: string;
  params: Record<string, number>;
  /** Fraction of that agent's sleeve per entry. */
  allocPct: number;
};

/** Always layered on top of whatever paper champion we copy. */
export const LIVE_RISK_PARAMS: Record<string, number> = {
  liquid: 1,
  maxPositions: 1,
  /** Deploy full cash on entry — do not shrink by ATR vol-target. */
  fullSleeve: 1,
  hardStopPct: 0.03,
  takeProfitPct: 0.09,
  maxMom: 0.04,
  startDelay: 0,
};

/**
 * Live sleeve follows the paper-league champion (recent 24h edge).
 * Fallback spec used until paper has a positive scorer.
 */
export const LIVE_AGENT_SPECS: LiveAgentSpec[] = [
  {
    id: "live_tsmom_5m_lb6_m10",
    strategy: "tsmom_atr",
    interval: "5m",
    params: {
      lookback: 48,
      minMom: 0.02,
      minVolRatio: 1.5,
      ...LIVE_RISK_PARAMS,
    },
    /** All-in on the single allowed position when a setup clears filters. */
    allocPct: 1,
  },
];

/** How often live re-reads the paper champion when flat. */
export const LIVE_ENSEMBLE_MS = 30 * 60_000;

/** @deprecated use LIVE_AGENT_SPECS[0] */
export const LIVE_AGENT_ID = LIVE_AGENT_SPECS[0].id;
export const LIVE_AGENT_SPEC = LIVE_AGENT_SPECS[0];
