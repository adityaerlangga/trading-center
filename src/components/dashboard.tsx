"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { agentNett, NettBadge } from "@/components/nett-badge";
import type { AgentView, Snapshot, Trade } from "@/lib/types";

const empty: Snapshot = {
  mode: "paper",
  running: false,
  starting: false,
  startedAt: null,
  interval: "5m",
  feeRate: 0.001,
  feeLabel: "Binance VIP0 taker 0.1%",
  feed: { connected: false, host: "", universe: 0, warmupDone: 0, warmupTotal: 0 },
  quotes: {},
  agents: [],
  trades: [],
  equity: {},
  league: [],
  btcReturnPct: 0,
  regime: "chop",
};

type StrategyOption = { name: string; label: string; note?: string; defaults: Record<string, number> };
type DeskTab = "paper" | "live";

function loadDeskTab(): DeskTab {
  if (typeof window === "undefined") return "live";
  return window.localStorage.getItem("deskEnv_v2") === "paper" ? "paper" : "live";
}

export function Dashboard() {
  const [desk, setDesk] = useState<DeskTab>("live");
  const [snap, setSnap] = useState<Snapshot>(empty);
  const [busy, setBusy] = useState(false);
  const [strategies, setStrategies] = useState<StrategyOption[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setDesk(loadDeskTab());
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("deskEnv_v2", desk);
    setSnap(empty);
    setActionError("");
  }, [desk]);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch(`/api/snapshot?env=${desk}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Snapshot;
        if (!cancelled) setSnap(data);
      } catch {
        // keep last snapshot
      }
    };
    void pull();
    const timer = setInterval(pull, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [desk]);

  useEffect(() => {
    if (desk !== "paper") return;
    void fetch(`/api/agents?env=paper`)
      .then((res) => res.json())
      .then((data: { strategies?: StrategyOption[] }) => {
        if (data.strategies) setStrategies(data.strategies);
      })
      .catch(() => undefined);
  }, [desk]);

  const isLive = desk === "live";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="font-mono text-[11px] tracking-[0.22em] text-accent uppercase">
              Research desk
            </p>
            <h1 className="text-xl font-semibold tracking-tight">Trading Center</h1>
            <div className="mt-2 flex gap-1">
              {(
                [
                  ["paper", "Paper"],
                  ["live", "Live"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-full border px-3 py-1 text-xs ${
                    desk === key
                      ? key === "live"
                        ? "border-down bg-down/15 text-down"
                        : "border-foreground bg-foreground text-background"
                      : "border-line text-muted hover:bg-card"
                  }`}
                  onClick={() => setDesk(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={isLive ? "down" : undefined}>{isLive ? "LIVE" : "PAPER"}</Badge>
            <Badge>{snap.interval}</Badge>
            <Badge>{snap.feed.universe} USDT pairs</Badge>
            <Badge>{snap.feeLabel || `fee ${(snap.feeRate * 100).toFixed(2)}%`}</Badge>
            <Badge tone={snap.feed.connected ? "up" : "down"}>{feedLabel(snap)}</Badge>
            <button
              className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-card"
              disabled={busy}
              onClick={() => void runAction(snap.running ? "stop" : "start", desk, setBusy, setActionError)}
            >
              {snap.starting ? "Starting…" : snap.running ? "Stop" : "Start"}
            </button>
            <button
              className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-card"
              disabled={busy}
              onClick={() => {
                if (
                  isLive &&
                  !confirm("Reset Live hanya reset state lokal (DB live). Tidak auto-sell posisi Binance.")
                ) {
                  return;
                }
                void runAction("reset", desk, setBusy, setActionError);
              }}
            >
              Reset
            </button>
            {!isLive ? (
              <button
                className="rounded-full bg-foreground px-3 py-1.5 text-sm text-background"
                onClick={() => setShowForm(true)}
              >
                New agent
              </button>
            ) : null}
          </div>
        </div>
        {isLive ? (
          <div className="border-t border-down/40 bg-down/10 px-5 py-2 text-center text-sm text-down">
            Order Spot nyata · {snap.agents.length || 3} agent ({snap.live?.agentId ?? "—"}) · budget $
            {(snap.live?.budgetUsdt ?? 0).toFixed(2)} · Spot USDT {(snap.live?.spotUsdt ?? 0).toFixed(2)} · keys{" "}
            {snap.live?.keysConfigured ? "OK" : "belum di-set"}
          </div>
        ) : null}
        {snap.starting || (snap.feed.warmupTotal > 0 && snap.feed.warmupDone < snap.feed.warmupTotal) ? (
          <p className="border-t border-line px-5 py-2 text-center font-mono text-xs text-muted">
            Warmup klines {snap.feed.warmupDone}/{snap.feed.warmupTotal}
          </p>
        ) : null}
        {snap.feed.error ? (
          <p className="border-t border-line px-5 py-2 text-center text-sm text-down">{snap.feed.error}</p>
        ) : null}
        {actionError ? (
          <p className="border-t border-line px-5 py-2 text-center text-sm text-down">{actionError}</p>
        ) : null}
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-5">
        {!isLive ? (
          <>
            <League rows={snap.league ?? []} btcReturnPct={snap.btcReturnPct ?? 0} regime={snap.regime ?? "chop"} />
            <LabPanel />
          </>
        ) : (
          <section className="rounded-2xl border border-down/30 bg-card p-5 text-sm">
            <h2 className="text-lg font-semibold">Live agent</h2>
            <p className="mt-1 text-muted">
              1× <span className="font-mono">tsmom_atr</span> 5m lb6 minMom 0.01 (top paper 5m saat ini) · full Spot sleeve ·
              alloc 100%.
            </p>
          </section>
        )}
        {snap.agents.length === 0 ? (
          <section className="rounded-2xl border border-line bg-card p-6 text-sm text-muted">
            {isLive
              ? "Live belum running. Pastikan keys REAL + Spot USDT cukup, lalu Start."
              : "Belum ada agent. Buat satu, pilih metode, isi saldo, lalu agent akan scan semua pair USDT."}
          </section>
        ) : (
          <section className={`grid gap-3 ${isLive ? "max-w-xl lg:grid-cols-1" : "lg:grid-cols-3"}`}>
            {[...snap.agents]
              .sort((a, b) => {
                const rank = new Map((snap.league ?? []).map((row) => [row.id, row.rank]));
                return (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999);
              })
              .slice(0, isLive ? 1 : 12)
              .map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  points={snap.equity[agent.id] ?? []}
                  desk={desk}
                  onDeleted={() =>
                    setSnap((prev) => ({
                      ...prev,
                      agents: prev.agents.filter((row) => row.id !== agent.id),
                    }))
                  }
                />
              ))}
          </section>
        )}
        <RecentTrades trades={snap.trades} />
      </main>

      {showForm && !isLive ? (
        <CreateAgentForm
          strategies={strategies}
          onClose={() => setShowForm(false)}
          onCreated={(agent) => {
            setSnap((prev) => ({ ...prev, agents: [...prev.agents, agent] }));
            setShowForm(false);
          }}
        />
      ) : null}
    </div>
  );
}

function AgentCard({
  agent,
  points,
  desk = "paper",
  onDeleted,
}: {
  agent: AgentView;
  points: { ts: number; equity: number }[];
  desk?: DeskTab;
  onDeleted: () => void;
}) {
  const up = agent.pnl >= 0;
  const nett = agentNett(agent.positions ?? []);
  const [deleting, setDeleting] = useState(false);
  const isLive = desk === "live";

  async function remove(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!confirm(`Hapus agent ${agent.id}?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/agents/${agent.id}?env=${desk}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Gagal hapus agent");
      }
      onDeleted();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="relative rounded-2xl border border-line bg-card p-4 text-left transition hover:border-accent">
      {!isLive ? (
        <button
          className="absolute right-3 top-3 rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:border-down hover:text-down"
          disabled={deleting}
          onClick={(event) => void remove(event)}
        >
          {deleting ? "…" : "Delete"}
        </button>
      ) : null}
      <Link href={`/agents/${agent.id}?env=${desk}`} className="block pr-16">
        <div>
          <p className="font-medium">
            {agent.id}
            {agent.status === "killed" ? (
              <span className="ml-2 rounded-full border border-down/40 px-2 py-0.5 text-xs text-down">killed</span>
            ) : null}
          </p>
          <p className="font-mono text-xs text-muted">
            {agent.strategy} · {agent.interval} · start {fmtUsd(agent.startingUsdt)} ·{" "}
            {agent.positionCount > 0 ? `hold ${agent.positionCount}` : "flat"}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">
            {agent.thought?.summary ?? "Menunggu scan pertama."}
          </p>
        </div>
        <p className={`mt-3 font-mono text-sm ${up ? "text-up" : "text-down"}`}>
          {fmtPct(agent.pnlPct)}
        </p>
        <p className="mt-1 font-mono text-2xl">{fmtUsd(agent.equity)}</p>
        <p className={`font-mono text-sm ${up ? "text-up" : "text-down"}`}>PnL {fmtUsd(agent.pnl)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted">Nett %</span>
            <NettBadge
              tone={nett.tone}
              kind="pct"
              value={nett.netPct}
              ready={nett.ready || agent.positionCount === 0}
            />
          </span>
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted">Nett profit</span>
            <NettBadge
              tone={nett.tone}
              kind="pnl"
              value={nett.netPnl}
              ready={nett.ready || agent.positionCount === 0}
            />
          </span>
        </div>
        <div className="mt-3 h-12 overflow-hidden">
          <Sparkline points={points} up={up} />
        </div>
        {(agent.positions ?? []).length > 0 ? (
          <div className="mt-3 max-h-40 overflow-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 font-medium">Coin</th>
                  <th className="py-1 font-medium">Nett %</th>
                  <th className="py-1 font-medium">Nett profit</th>
                </tr>
              </thead>
              <tbody>
                {(agent.positions ?? []).map((pos) => (
                  <tr key={pos.symbol} className="border-t border-line">
                    <td className="py-1.5">{pos.symbol}</td>
                    <td className="py-1.5">
                      <NettBadge
                        tone={pos.tone ?? "even"}
                        kind="pct"
                        value={pos.netPct ?? 0}
                        ready={(pos.exitPrice ?? pos.mark) > 0}
                      />
                    </td>
                    <td className="py-1.5">
                      <NettBadge
                        tone={pos.tone ?? "even"}
                        kind="pnl"
                        value={pos.netPnl ?? 0}
                        ready={(pos.exitPrice ?? pos.mark) > 0}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="mt-3 flex justify-between font-mono text-xs text-muted">
          <span>cash {fmtUsd(agent.usdt)}</span>
          <span>{agent.positionCount} coins</span>
          <span>
            {agent.lastSignal}
            {agent.lastSymbol ? ` ${agent.lastSymbol}` : ""}
          </span>
        </div>
      </Link>
    </div>
  );
}

function methodBoard(rows: Snapshot["league"]) {
  const groups = new Map<string, { strategy: string; interval: string; pnl: number[] }>();
  for (const row of rows) {
    if (!row.soldReady) continue;
    const key = `${row.interval}|${row.strategy}`;
    const group = groups.get(key) ?? { strategy: row.strategy, interval: row.interval, pnl: [] };
    group.pnl.push(row.soldPnl);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.pnl].sort((a, b) => a - b);
      const mid =
        sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
      const mean = group.pnl.reduce((sum, value) => sum + value, 0) / group.pnl.length;
      return {
        key: `${group.interval}-${group.strategy}`,
        strategy: group.strategy,
        interval: group.interval,
        n: group.pnl.length,
        median: mid,
        mean,
        best: sorted.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.median - a.median);
}

function MethodBoard({ rows }: { rows: Snapshot["league"] }) {
  const methods = methodBoard(rows);
  if (methods.length === 0) return null;
  return (
    <div className="mb-4 max-h-96 overflow-auto">
      <p className="mb-2 text-xs text-muted">Metode, median uang bersih dari semua salinan $100</p>
      <table className="w-full text-left font-mono text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-2 font-medium">#</th>
            <th className="py-2 font-medium">Speed</th>
            <th className="py-2 font-medium">Method</th>
            <th className="py-2 font-medium">Sampel</th>
            <th className="py-2 text-right font-medium">Median jual</th>
            <th className="py-2 text-right font-medium">Rata-rata</th>
            <th className="py-2 text-right font-medium">Terbaik</th>
          </tr>
        </thead>
        <tbody>
          {methods.map((method, index) => (
            <tr key={method.key} className="border-t border-line">
              <td className="py-2">{index + 1}</td>
              <td>{method.interval}</td>
              <td>{method.strategy}</td>
              <td>{method.n}</td>
              <td className={`py-2 text-right ${method.median > 0 ? "text-up" : method.median < 0 ? "text-down" : ""}`}>
                {fmtSignedUsd(method.median)}
              </td>
              <td className={`py-2 text-right ${method.mean > 0 ? "text-up" : method.mean < 0 ? "text-down" : ""}`}>
                {fmtSignedUsd(method.mean)}
              </td>
              <td className={`py-2 text-right ${method.best > 0 ? "text-up" : method.best < 0 ? "text-down" : ""}`}>
                {fmtSignedUsd(method.best)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function League({
  rows,
  btcReturnPct,
  regime,
}: {
  rows: Snapshot["league"];
  btcReturnPct: number;
  regime: Snapshot["regime"];
}) {
  const [posisiFilter, setPosisiFilter] = useState<"all" | "hold" | "flat">("all");
  const holding = rows.filter((row) => row.positionCount > 0).length;
  const flat = rows.length - holding;
  const filtered =
    posisiFilter === "hold"
      ? rows.filter((row) => row.positionCount > 0)
      : posisiFilter === "flat"
        ? rows.filter((row) => row.positionCount === 0)
        : rows;

  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-semibold">Liga</h2>
        <p className="font-mono text-xs text-muted">
          {rows.length} sampel · hold {holding} · flat {flat} · BTC {fmtPct(btcReturnPct)} · {regime === "chop" ? "chop" : "trend"}
        </p>
      </div>
      {rows[0] ? (
        <div className="mb-4 rounded-xl border border-line bg-background px-4 py-3">
          <p className="text-xs text-muted">Pemimpin uang bersih</p>
          <p className="mt-1 text-lg font-semibold">
            <Link href={`/agents/${rows[0].id}`}>{rows[0].id}</Link>
          </p>
          <p className={`font-mono text-2xl ${rows[0].soldPnl > 0 ? "text-up" : rows[0].soldPnl < 0 ? "text-down" : ""}`}>
            {rows[0].soldReady ? fmtSignedUsd(rows[0].soldPnl) : "Menunggu bid"}
          </p>
          <p className="font-mono text-xs text-muted">
            {rows[0].strategy} · {rows[0].interval}
            {rows[0].soldReady ? ` · ${fmtPct(rows[0].soldPct)}` : ""} ·{" "}
            {rows[0].positionCount > 0 ? `hold ${rows[0].positionCount} koin` : "flat"} ·{" "}
            {rows.filter((row) => row.soldReady && row.soldPnl > 0).length} agent uang bersih di atas nol
          </p>
        </div>
      ) : null}
      <MethodBoard rows={rows} />
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Belum ada peserta. Agent yang kalah BTC dan Sharpe negatif setelah 7 hari di-kill.</p>
      ) : (
        <div className="overflow-auto">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              {filtered.length === rows.length
                ? "25 agent teratas"
                : `${Math.min(25, filtered.length)} dari ${filtered.length} agent ${posisiFilter === "hold" ? "yang hold" : "yang flat"}`}
            </p>
            <div className="flex gap-1">
              {(
                [
                  ["all", "Semua"],
                  ["hold", "Hold"],
                  ["flat", "Flat"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    posisiFilter === key
                      ? "border-foreground bg-foreground text-background"
                      : "border-line text-muted hover:bg-background"
                  }`}
                  onClick={() => setPosisiFilter(key)}
                >
                  {label}
                  {key === "hold" ? ` ${holding}` : key === "flat" ? ` ${flat}` : ""}
                </button>
              ))}
            </div>
          </div>
          <table className="w-full text-left font-mono text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 font-medium">#</th>
                <th className="py-2 font-medium">Agent</th>
                <th className="py-2 font-medium">Speed</th>
                <th className="py-2 font-medium">Method</th>
                <th className="py-2 font-medium">Posisi</th>
                <th className="py-2 font-medium">PnL</th>
                <th className="py-2 font-medium">vs BTC</th>
                <th className="py-2 font-medium">Sharpe</th>
                <th className="py-2 font-medium">Alloc</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Jual semua</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 25).map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="py-2">{row.rank}</td>
                  <td>
                    <Link href={`/agents/${row.id}`}>{row.id}</Link>
                  </td>
                  <td>{row.interval}</td>
                  <td>{row.strategy}</td>
                  <td className={row.positionCount > 0 ? "text-up" : "text-muted"}>
                    {row.positionCount > 0 ? `Hold · ${row.positionCount}` : "Flat"}
                  </td>
                  <td className={row.pnlPct >= 0 ? "text-up" : "text-down"}>{fmtPct(row.pnlPct)}</td>
                  <td className={row.vsBtc >= 0 ? "text-up" : "text-down"}>{fmtPct(row.vsBtc)}</td>
                  <td>{row.sharpe.toFixed(2)}</td>
                  <td>{(row.allocPct * 100).toFixed(0)}%</td>
                  <td className={row.status === "killed" ? "text-down" : "text-muted"}>{row.status}</td>
                  <td className={`py-2 text-right whitespace-nowrap ${row.soldPnl > 0 ? "text-up" : row.soldPnl < 0 ? "text-down" : ""}`}>
                    {row.soldReady ? `${fmtSignedUsd(row.soldPnl)} · ${fmtPct(row.soldPct)}` : "Menunggu bid"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type LabReport = {
  id: string;
  strategy: string;
  interval: string;
  passed: boolean;
  aggregate: { returnPct: number; excessVsBtc: number; maxDrawdownPct: number; sharpe: number; reason: string };
};

function LabPanel() {
  const [rows, setRows] = useState<LabReport[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    void fetch("/api/research", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { experiments?: LabReport[] }) => setRows(data.experiments ?? []))
      .catch(() => undefined);
  }, []);

  async function promote(id: string) {
    const startingUsdt = prompt("Saldo paper untuk agent ini?", "1000");
    if (!startingUsdt) return;
    setBusy(id);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experimentId: id, startingUsdt }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal promote");
      window.location.reload();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-lg font-semibold">Lab</h2>
        <p className="text-xs text-muted">Walk-forward 1h + fee. Promote hanya jika lolos vs BTC.</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Belum ada eksperimen. Jalankan `npm run research -- --strategy tsmom_atr`.</p>
      ) : (
        <div className="grid gap-2">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-sm">
              <div>
                <p className="font-medium">
                  {row.strategy} · {row.interval} · {row.passed ? "PASS" : "FAIL"}
                </p>
                <p className="font-mono text-xs text-muted">
                  ret {fmtPct(row.aggregate.returnPct)} · excess {fmtPct(row.aggregate.excessVsBtc)} · DD{" "}
                  {row.aggregate.maxDrawdownPct.toFixed(1)}% · {row.aggregate.reason}
                </p>
              </div>
              <button
                className="rounded-full border border-line px-3 py-1 text-xs disabled:opacity-40"
                disabled={!row.passed || busy === row.id}
                onClick={() => void promote(row.id)}
              >
                {busy === row.id ? "…" : "Promote"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateAgentForm({
  strategies,
  onClose,
  onCreated,
}: {
  strategies: StrategyOption[];
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
}) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState(strategies[0]?.name ?? "tsmom_atr");
  const [startingUsdt, setStartingUsdt] = useState("");
  const [allocPct, setAllocPct] = useState("20");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const selected = strategies.find((row) => row.name === strategy);

  async function submit() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          strategy,
          startingUsdt,
          allocPct: Number(allocPct) / 100,
          params: selected?.defaults ?? {},
        }),
      });
      const data = (await res.json()) as AgentView & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create agent");
      onCreated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-card p-5">
        <h2 className="text-lg font-semibold">New agent</h2>
        <p className="mt-1 text-sm text-muted">
          Agent scan semua pair USDT, tapi alokasi bukan perintah beli.
          Cash boleh menganggur sampai setup lolos filter jurnal (TSMOM / ATR).
        </p>
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm">
            Name
            <input
              className="rounded-xl border border-line bg-background px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="sma_wide"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Method
            <select
              className="rounded-xl border border-line bg-background px-3 py-2"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
            >
              {(strategies.length ? strategies : [
                { name: "tsmom_atr", label: "TSMOM + ATR stop" },
                { name: "xs_momentum", label: "Cross-sectional momentum" },
                { name: "dual_momentum", label: "Dual momentum" },
                { name: "donchian", label: "Donchian breakout" },
                { name: "sma_crossover", label: "SMA crossover (filtered)" },
                { name: "rsi_mean_reversion", label: "RSI rebound" },
              ]).map((row) => (
                <option key={row.name} value={row.name}>
                  {row.label}
                </option>
              ))}
            </select>
            {selected?.note ? <p className="text-xs text-muted">{selected.note}</p> : null}
          </label>
          <label className="grid gap-1 text-sm">
            Saldo awal (USDT)
            <input
              className="rounded-xl border border-line bg-background px-3 py-2"
              inputMode="decimal"
              value={startingUsdt}
              onChange={(e) => setStartingUsdt(e.target.value)}
              placeholder="contoh: 1000"
            />
          </label>
          <label className="grid gap-1 text-sm">
            Plafon alokasi per coin (%) — bukan target belanja
            <input
              className="rounded-xl border border-line bg-background px-3 py-2"
              type="number"
              min="1"
              max="100"
              value={allocPct}
              onChange={(e) => setAllocPct(e.target.value)}
            />
          </label>
          {error ? <p className="text-sm text-down">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="rounded-full border border-line px-3 py-1.5 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded-full bg-foreground px-3 py-1.5 text-sm text-background"
            disabled={saving || !name || !startingUsdt}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecentTrades({ trades }: { trades: Trade[] }) {
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Recent fills</h2>
        <p className="font-mono text-xs text-muted">paper · scan all USDT</p>
      </div>
      {trades.length === 0 ? (
        <p className="text-sm text-muted">Belum ada fill. Agent evaluasi saat candle 5m close.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-left font-mono text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 font-medium">Agent</th>
                <th className="py-2 font-medium">Symbol</th>
                <th className="py-2 font-medium">Side</th>
                <th className="py-2 font-medium">Qty</th>
                <th className="py-2 font-medium">Price</th>
                <th className="py-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.id} className="border-t border-line">
                  <td className="py-2">{trade.agentId}</td>
                  <td>{trade.symbol}</td>
                  <td className={trade.side === "BUY" ? "text-up" : "text-down"}>{trade.side}</td>
                  <td>{trade.qty}</td>
                  <td>{fmtPrice(trade.price)}</td>
                  <td className="text-muted">{fmtTime(trade.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Sparkline({
  points,
  up,
}: {
  points: { ts: number; equity: number }[];
  up: boolean;
}) {
  const path = useMemo(() => {
    if (points.length < 2) return "";
    const values = points.map((p) => p.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return points
      .map((point, index) => {
        const x = (index / (points.length - 1)) * 100;
        const y = 100 - ((point.equity - min) / span) * 100;
        return `${index === 0 ? "M" : "L"} ${x} ${y}`;
      })
      .join(" ");
  }, [points]);

  if (!path) return <div className="h-full rounded-md bg-background/60" />;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
      <path d={path} fill="none" stroke={up ? "#3ee687" : "#ff5c7a"} strokeWidth="2" />
    </svg>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone?: "up" | "down" }) {
  const color =
    tone === "up" ? "text-up border-up/30" : tone === "down" ? "text-down border-down/30" : "";
  return (
    <span className={`rounded-full border border-line px-2.5 py-1 font-mono text-xs ${color}`}>
      {children}
    </span>
  );
}

function feedLabel(snap: Snapshot) {
  if (snap.starting) return "Warming up";
  if (snap.feed.connected) return "Live Binance";
  if (snap.running) return "Reconnecting";
  return "Idle";
}

async function runAction(
  action: "start" | "stop" | "reset",
  env: DeskTab,
  setBusy: (v: boolean) => void,
  setError: (v: string) => void,
) {
  setBusy(true);
  setError("");
  try {
    const res = await fetch("/api/engine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, env }),
    });
    const data = (await res.json()) as Snapshot & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Gagal ${action}`);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

export function fmtSignedUsd(value: number) {
  const text = fmtUsd(Math.abs(value));
  if (value > 0) return `+${text}`;
  if (value < 0) return `-${text}`;
  return text;
}

export function fmtUsd(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export function fmtPct(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function fmtPrice(value: number) {
  if (!value) return "—";
  return value >= 100
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}
