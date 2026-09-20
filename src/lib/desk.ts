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
 * Single live agent — current paper #1 on 5m:
 * spd_5m_tsmom_lb6_m10_d8 → tsmom_atr lookback 6, minMom 0.01
 * (startDelay 0 on live so it can trade immediately)
 */
export const LIVE_AGENT_SPECS: LiveAgentSpec[] = [
  {
    id: "live_tsmom_5m_lb6_m10",
    strategy: "tsmom_atr",
    interval: "5m",
    params: { lookback: 6, minMom: 0.01, startDelay: 0 },
    allocPct: 1,
  },
];

/** @deprecated use LIVE_AGENT_SPECS[0] */
export const LIVE_AGENT_ID = LIVE_AGENT_SPECS[0].id;
export const LIVE_AGENT_SPEC = LIVE_AGENT_SPECS[0];
