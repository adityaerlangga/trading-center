"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fmtPct, fmtPrice, fmtSignedUsd, fmtTime, fmtUsd } from "@/components/dashboard";
import { agentNett } from "@/components/nett-badge";
import { deskFetch } from "@/lib/desk-auth";
import type { AgentThought, AgentView, EquityPoint, Trade } from "@/lib/types";

type Detail = AgentView & { trades: Trade[]; equitySeries: EquityPoint[] };

export function AgentDetail({ id, env }: { id: string; env: "paper" | "live" }) {
  const router = useRouter();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [startingUsdt, setStartingUsdt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const res = await deskFetch(`/api/agents/${id}?env=${env}`);
      if (!res.ok) {
        if (!cancelled) setError("Agent not found");
        return;
      }
      const data = (await res.json()) as Detail;
      if (!cancelled) {
        setDetail(data);
        setStartingUsdt((current) => current || String(data.startingUsdt));
      }
    };
    void pull();
    const timer = setInterval(pull, 4_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, env]);

  async function saveBalance() {
    setSaving(true);
    try {
      const res = await deskFetch(`/api/agents/${id}?env=${env}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startingUsdt, env }),
      });
      const data = (await res.json()) as Detail & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Gagal update saldo");
      setDetail((prev) => (prev ? { ...prev, ...data } : prev));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Hapus agent ${id}?`)) return;
    const res = await deskFetch(`/api/agents/${id}?env=${env}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      alert(data.error ?? "Gagal hapus agent");
      return;
    }
    router.push(`/?env=${env}`);
  }

  if (error) {
    return (
      <main className="mx-auto max-w-5xl px-5 py-10">
        <p className="text-down">{error}</p>
        <Link href={`/?env=${env}`} className="mt-4 inline-block text-sm text-muted">
          Back
        </Link>
      </main>
    );
  }

  if (!detail) {
    return <main className="px-5 py-10 text-sm text-muted">Loading {id}…</main>;
  }

  const up = detail.pnl >= 0;
  const nett = agentNett(detail.positions ?? []);
  const nettToneClass =
    nett.tone === "profit" ? "up" : nett.tone === "loss" ? "down" : "even";

  return (
    <main className="mx-auto grid max-w-5xl gap-5 px-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/?env=${env}`} className="font-mono text-xs text-muted">
            ← desk
          </Link>
          <h1 className="text-2xl font-semibold">{detail.id}</h1>
          <p className="font-mono text-sm text-muted">
            {env} · {detail.strategy} · {detail.interval} · alloc {(detail.allocPct * 100).toFixed(0)}% / coin · start{" "}
            {fmtUsd(detail.startingUsdt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="w-36 rounded-full border border-line bg-card px-3 py-1.5 font-mono text-sm"
            value={startingUsdt}
            onChange={(e) => setStartingUsdt(e.target.value)}
            placeholder="Saldo awal"
          />
          <button
            className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-card"
            disabled={saving}
            onClick={() => void saveBalance()}
          >
            {saving ? "Saving…" : "Set saldo"}
          </button>
          <button
            className="rounded-full border border-line px-3 py-1.5 text-sm hover:bg-card"
            onClick={() => void remove()}
          >
            Delete
          </button>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Equity" value={fmtUsd(detail.equity)} />
        <Stat label="PnL" value={fmtUsd(detail.pnl)} tone={up ? "up" : "down"} />
        <Stat label="Nett %" value={fmtPct(nett.netPct)} tone={nettToneClass} />
        <Stat label="Nett profit" value={fmtUsd(nett.netPnl)} tone={nettToneClass} />
        <Stat label="Cash" value={fmtUsd(detail.usdt)} />
        <Stat label="Coins" value={String(detail.positionCount)} />
      </section>

      <Thinking thought={detail.thought} />

      <section className="rounded-2xl border border-line bg-card p-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="text-lg font-semibold">Posisi</h2>
          <p className="text-xs text-muted">
            Harga beli termasuk fee. Kalau dijual = untung di bid sekarang, setelah fee jual dan pajak 1%.
          </p>
        </div>
        {detail.positions.length === 0 ? (
          <p className="text-sm text-muted">Flat. Agent belum masuk coin, atau sudah keluar semua.</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-left font-mono text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 font-medium">Koin</th>
                  <th className="py-2 font-medium">Jumlah</th>
                  <th className="py-2 font-medium">Harga beli</th>
                  <th className="py-2 font-medium">Jam beli</th>
                  <th className="py-2 font-medium">Bid sekarang</th>
                  <th className="py-2 text-right font-medium">Kalau dijual</th>
                </tr>
              </thead>
              <tbody>
                {detail.positions.map((pos) => {
                  const ready = (pos.exitPrice ?? 0) > 0;
                  return (
                    <tr key={pos.symbol} className="border-t border-line">
                      <td className="py-2">{pos.symbol.replace(/USDT$/, "")}</td>
                      <td>{pos.qty}</td>
                      <td>{pos.entryPrice ? fmtPrice(pos.entryPrice) : "—"}</td>
                      <td className="whitespace-nowrap text-muted">{fmtWhen(pos.boughtAt)}</td>
                      <td>{ready ? fmtPrice(pos.exitPrice) : "Menunggu bid"}</td>
                      <td className={`py-2 text-right whitespace-nowrap ${pos.netPnl > 0 ? "text-up" : pos.netPnl < 0 ? "text-down" : ""}`}>
                        {ready ? fmtSignedUsd(pos.netPnl) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-card p-5">
        <h2 className="mb-3 text-lg font-semibold">Log isi</h2>
        {detail.trades.length === 0 ? (
          <p className="text-sm text-muted">Belum ada beli atau jual.</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-left font-mono text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 font-medium">Jam</th>
                  <th className="py-2 font-medium">Aksi</th>
                  <th className="py-2 font-medium">Koin</th>
                  <th className="py-2 font-medium">Jumlah</th>
                  <th className="py-2 font-medium">Harga</th>
                  <th className="py-2 font-medium">Fee</th>
                </tr>
              </thead>
              <tbody>
                {detail.trades.map((trade) => (
                  <tr key={trade.id} className="border-t border-line">
                    <td className="whitespace-nowrap text-muted">{fmtWhen(trade.ts)}</td>
                    <td className={trade.side === "BUY" ? "text-up" : "text-down"}>
                      {trade.side === "BUY" ? "Beli" : "Jual"}
                    </td>
                    <td>{trade.symbol.replace(/USDT$/, "")}</td>
                    <td>{trade.qty}</td>
                    <td>{fmtPrice(trade.price)}</td>
                    <td>{fmtUsd(trade.fee)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Thinking({ thought }: { thought?: AgentThought }) {
  if (!thought) return null;
  const next = thought.nextCandleAt
    ? new Date(thought.nextCandleAt).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : "—";
  return (
    <section className="rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Thinking</h2>
          <p className="text-sm text-muted">{thought.summary}</p>
        </div>
        <p className="font-mono text-xs text-muted">
          {thought.status} · scan {thought.scanned} · buy {thought.buySignals} · jual {thought.sellSignals} · next {next}
        </p>
      </div>
      {thought.topBuys.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 text-xs text-muted">Watchlist — belum tentu dibeli</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {thought.topBuys.map((buy) => (
              <p key={buy.symbol} className="rounded-xl border border-line px-3 py-2 font-mono text-xs">
                {buy.symbol} · {buy.reason}
              </p>
            ))}
          </div>
        </div>
      ) : null}
      <div className="max-h-72 overflow-auto">
        {thought.notes.length === 0 ? (
          <p className="text-sm text-muted">Belum ada log. Agent scan saat candle close atau langsung setelah dibuat.</p>
        ) : (
          <ul className="grid gap-2">
            {thought.notes.map((note, index) => (
              <li key={`${note.ts}-${index}`} className="border-t border-line pt-2 font-mono text-xs">
                <span className="text-muted">{fmtTime(note.ts)} · {note.action}</span>
                <p className="mt-1 text-foreground">{note.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function fmtWhen(ts: number | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("id-ID", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "even";
}) {
  return (
    <article className="rounded-2xl border border-line bg-card px-4 py-4">
      <p className="text-xs text-muted">{label}</p>
      <p
        className={`mt-1 font-mono text-xl ${
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "even" ? "text-even" : ""
        }`}
      >
        {value}
      </p>
    </article>
  );
}
