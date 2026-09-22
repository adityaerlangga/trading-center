import type { AgentRuntime, EquityPoint, Signal, Trade } from "../types";
import { ensureSchema, getPool, query } from "./mysql";
import type { RowDataPacket } from "mysql2/promise";
import { rowToAgent, type PersistedState } from "./store";

type MetaRow = RowDataPacket & { v: string };
type AgentRow = RowDataPacket & {
  id: string;
  strategy: string;
  starting_usdt: string;
  alloc_pct?: string;
  base_alloc?: string | null;
  params: AgentRuntime["params"] | string;
  usdt: string;
  holdings: AgentRuntime["holdings"] | string;
  last_signal: Signal;
  last_error: string | null;
  last_symbol: string | null;
  status?: string | null;
  born_at?: number | null;
  btc_at_birth?: string | null;
  trade_interval?: string | null;
};
type TradeRow = RowDataPacket & {
  id: string;
  agent_id: string;
  symbol: string;
  side: Trade["side"];
  qty: string;
  price: string;
  fee: string;
  ts: number;
};
type EquityRow = RowDataPacket & {
  agent_id: string;
  ts: number;
  equity: string;
};

let ready: Promise<void> | null = null;

async function readyLiveDb() {
  if (!ready) ready = ensureSchema();
  await ready;
}

export async function loadLiveState(): Promise<PersistedState | null> {
  await readyLiveDb();
  const agents = await query<AgentRow>("SELECT * FROM agents_live");
  if (agents.length === 0) return null;

  const trades = await query<TradeRow>(
    "SELECT * FROM trades_live ORDER BY ts DESC, id DESC LIMIT 4000",
  );
  const points = await query<EquityRow>(
    "SELECT agent_id, ts, equity FROM equity_points_live ORDER BY agent_id, ts",
  );
  const started = await query<MetaRow>("SELECT v FROM meta_live WHERE k = 'started_at'");

  const equity: Record<string, EquityPoint[]> = {};
  for (const point of points) {
    equity[point.agent_id] ??= [];
    equity[point.agent_id].push({
      ts: Number(point.ts),
      equity: Number(point.equity),
    });
  }

  return {
    startedAt: started[0] ? Number(started[0].v) : null,
    agents: agents.map(rowToAgent),
    trades: trades
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        symbol: row.symbol,
        side: row.side,
        qty: Number(row.qty),
        price: Number(row.price),
        fee: Number(row.fee),
        ts: Number(row.ts),
      }))
      .reverse(),
    equity,
  };
}

export async function saveLiveState(state: PersistedState) {
  await readyLiveDb();
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO meta_live (k, v) VALUES ('started_at', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [state.startedAt == null ? "" : String(state.startedAt)],
    );

    for (const agent of state.agents) {
      await upsertLiveAgent(conn, agent);
    }

    const tradeRows = state.trades.map((trade) => [
      trade.id,
      trade.agentId,
      trade.symbol,
      trade.side,
      trade.qty,
      trade.price,
      trade.fee,
      trade.ts,
    ]);
    for (let i = 0; i < tradeRows.length; i += 80) {
      const slice = tradeRows.slice(i, i + 80);
      await conn.query(
        `INSERT IGNORE INTO trades_live (id, agent_id, symbol, side, qty, price, fee, ts) VALUES ${slice
          .map(() => "(?, ?, ?, ?, ?, ?, ?, ?)")
          .join(",")}`,
        slice.flat(),
      );
    }

    const points: unknown[] = [];
    for (const [agentId, series] of Object.entries(state.equity)) {
      for (const point of series) points.push(agentId, point.ts, point.equity);
    }
    for (let i = 0; i < points.length; i += 240) {
      const slice = points.slice(i, i + 240);
      const n = slice.length / 3;
      await conn.query(
        `INSERT IGNORE INTO equity_points_live (agent_id, ts, equity) VALUES ${Array.from({ length: n }, () => "(?, ?, ?)").join(",")}`,
        slice,
      );
    }

    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function insertLiveAgent(agent: AgentRuntime) {
  await readyLiveDb();
  await upsertLiveAgent(getPool(), agent);
}

export async function deleteLiveAgent(id: string) {
  await readyLiveDb();
  const db = getPool();
  await db.query("DELETE FROM equity_points_live WHERE agent_id = ?", [id]);
  await db.query("DELETE FROM trades_live WHERE agent_id = ?", [id]);
  await db.query("DELETE FROM agents_live WHERE id = ?", [id]);
}

export async function loadLiveAgentTrades(agentId: string): Promise<Trade[]> {
  await readyLiveDb();
  const [rows] = await getPool().query<TradeRow[]>(
    "SELECT id, agent_id, symbol, side, qty, price, fee, ts FROM trades_live WHERE agent_id = ? ORDER BY ts ASC",
    [agentId],
  );
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    symbol: row.symbol,
    side: row.side,
    qty: Number(row.qty),
    price: Number(row.price),
    fee: Number(row.fee),
    ts: Number(row.ts),
  }));
}

export async function insertLiveTrade(trade: Trade) {
  await readyLiveDb();
  await getPool().query(
    `INSERT IGNORE INTO trades_live (id, agent_id, symbol, side, qty, price, fee, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [trade.id, trade.agentId, trade.symbol, trade.side, trade.qty, trade.price, trade.fee, trade.ts],
  );
}

export async function getLiveMeta(key: string): Promise<string | null> {
  await readyLiveDb();
  const [rows] = await getPool().query<MetaRow[]>("SELECT v FROM meta_live WHERE k = ?", [key]);
  const value = rows[0]?.v;
  if (value == null || value === "") return null;
  return String(value);
}

export async function setLiveMeta(key: string, value: string) {
  await readyLiveDb();
  await getPool().query(
    "INSERT INTO meta_live (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
    [key, value],
  );
}

export async function resetLivePortfolios() {
  await readyLiveDb();
  const db = getPool();
  await db.query("DELETE FROM equity_points_live");
  await db.query("DELETE FROM trades_live");
  await db.query("DELETE FROM meta_live");
  await db.query(
    `UPDATE agents_live
     SET usdt = starting_usdt,
         holdings = JSON_OBJECT(),
         last_signal = 'HOLD',
         last_error = NULL,
         last_symbol = NULL`,
  );
}

async function upsertLiveAgent(
  conn: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  agent: AgentRuntime,
) {
  await conn.query(
    `INSERT INTO agents_live (
      id, strategy, symbol, starting_usdt, alloc_pct, base_alloc, params, usdt, holdings,
      last_signal, last_error, last_symbol, status, born_at, btc_at_birth, trade_interval
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      strategy = VALUES(strategy),
      starting_usdt = VALUES(starting_usdt),
      alloc_pct = VALUES(alloc_pct),
      base_alloc = VALUES(base_alloc),
      params = VALUES(params),
      usdt = VALUES(usdt),
      holdings = VALUES(holdings),
      last_signal = VALUES(last_signal),
      last_error = VALUES(last_error),
      last_symbol = VALUES(last_symbol),
      status = VALUES(status),
      born_at = VALUES(born_at),
      btc_at_birth = VALUES(btc_at_birth),
      trade_interval = VALUES(trade_interval)`,
    [
      agent.id,
      agent.strategy,
      agent.startingUsdt,
      agent.allocPct,
      agent.baseAlloc || agent.allocPct,
      JSON.stringify(agent.params),
      agent.usdt,
      JSON.stringify(agent.holdings),
      agent.lastSignal,
      agent.lastError ?? null,
      agent.lastSymbol ?? null,
      agent.status ?? "active",
      agent.bornAt || Date.now(),
      agent.btcAtBirth || 0,
      agent.interval || "5m",
    ],
  );
}
