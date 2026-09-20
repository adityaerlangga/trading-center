import type { PositionTone } from "@/lib/types";

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function pct(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function nettTone(netPnl: number, netPct = 0): PositionTone {
  if (Math.abs(netPnl) < 0.03 || Math.abs(netPct) < 0.25) return "even";
  return netPnl > 0 ? "profit" : "loss";
}

export function agentNett(positions: { cost?: number; netPnl?: number; exitPrice?: number; mark?: number }[]) {
  const ready = positions.length > 0 && positions.every((pos) => (pos.exitPrice ?? pos.mark ?? 0) > 0);
  const netPnl = positions.reduce((sum, pos) => sum + (pos.netPnl ?? 0), 0);
  const cost = positions.reduce((sum, pos) => sum + (pos.cost ?? 0), 0);
  const netPct = cost > 0 ? (netPnl / cost) * 100 : 0;
  return {
    netPnl,
    netPct,
    tone: positions.length === 0 || !ready ? ("even" as const) : nettTone(netPnl, netPct),
    ready,
  };
}

export function NettBadge({
  tone,
  value,
  kind,
  ready = true,
}: {
  tone: PositionTone;
  value: number;
  kind: "pct" | "pnl";
  ready?: boolean;
}) {
  if (!ready) {
    return (
      <span className="inline-flex rounded-full border border-line bg-bg/40 px-2.5 py-0.5 text-xs text-muted">
        —
      </span>
    );
  }
  const color =
    tone === "profit"
      ? "border-up/40 bg-up/10 text-up"
      : tone === "loss"
        ? "border-down/40 bg-down/10 text-down"
        : "border-even/40 bg-even/10 text-even";
  const label = kind === "pct" ? pct(value) : `${value > 0 ? "+" : ""}${money(value)}`;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs ${color}`}>
      {label}
    </span>
  );
}
