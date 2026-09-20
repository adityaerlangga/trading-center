import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { AppConfig, Mode } from "./types";

type RawConfig = {
  mode?: Mode;
  interval?: string;
  on_signal?: "candle_close";
  fee_rate?: number;
};

export function loadConfig(cwd = process.cwd()): AppConfig {
  const file = path.join(cwd, "config", "agents.yaml");
  const raw = parse(readFileSync(file, "utf8")) as RawConfig;
  const mode = raw.mode ?? "paper";
  if (mode === "live") {
    throw new Error("Live trading is disabled. Keep mode: paper in config/agents.yaml");
  }

  return {
    mode,
    interval: raw.interval ?? "5m",
    onSignal: raw.on_signal ?? "candle_close",
    feeRate: raw.fee_rate ?? 0.001,
  };
}

const PEGGED = new Set(["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "USD1", "USDE", "EUR", "AEUR"]);

export function baseAsset(symbol: string): string {
  return symbol.replace(/(FDUSD|USDT|USDC|BUSD|TUSD)$/i, "");
}

export function isPegged(assetOrSymbol: string): boolean {
  const base = PEGGED.has(assetOrSymbol) ? assetOrSymbol : baseAsset(assetOrSymbol);
  return PEGGED.has(base);
}

export function toSymbol(asset: string): string {
  return asset.endsWith("USDT") ? asset : `${asset}USDT`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (!slug) throw new Error("Agent name must contain letters or numbers");
  return slug.slice(0, 64);
}
