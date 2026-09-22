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
  /** Fraction of that agent's sleeve per entry. Small live sleeves use 1.0 to clear min notional. */
  allocPct: number;
};

/**
 * Paper leader on 5m: tsmom_atr lookback 6, minMom 0.01.
 * Scans when each 5m candle closes.
 * 50% sleeve × max 2 names, hard stop -5%, skip chase if already up >4%.
 */
export const LIVE_AGENT_SPECS: LiveAgentSpec[] = [
  {
    id: "live_tsmom_5m_lb6_m10",
    strategy: "tsmom_atr",
    interval: "5m",
    params: {
      lookback: 6,
      minMom: 0.01,
      maxMom: 0.04,
      hardStopPct: 0.05,
      liquid: 1,
      maxPositions: 2,
      startDelay: 1,
    },
    allocPct: 0.5,
  },
];

/** @deprecated use LIVE_AGENT_SPECS[0] */
export const LIVE_AGENT_ID = LIVE_AGENT_SPECS[0].id;
export const LIVE_AGENT_SPEC = LIVE_AGENT_SPECS[0];
