import type { AgentRuntime, EquityPoint, Signal, Trade } from "../types";
import { ensureSchema, getPool, query } from "./mysql";
import type { RowDataPacket } from "mysql2/promise";

export type PersistedState = {
  startedAt: number | null;
  agents: AgentRuntime[];
  trades: Trade[];
  equity: Record<string, EquityPoint[]>;
};

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

export async function readyDb() {
  if (!ready) ready = ensureSchema();
  await ready;
}

export function rowToAgent(row: AgentRow): AgentRuntime {
  return {
    id: row.id,
    strategy: row.strategy,
    startingUsdt: Number(row.starting_usdt),
    allocPct: Number(row.alloc_pct ?? 0.1),
    baseAlloc: Number(row.base_alloc ?? row.alloc_pct ?? 0.1),
    params: parseJson(row.params, {}),
    usdt: Number(row.usdt),
    holdings: parseJson(row.holdings, {}),
    lastSignal: row.last_signal,
    lastError: row.last_error ?? undefined,
    lastSymbol: row.last_symbol ?? undefined,
    status: row.status === "killed" ? "killed" : "active",
    bornAt: Number(row.born_at ?? 0),
    btcAtBirth: Number(row.btc_at_birth ?? 0),
    interval: row.trade_interval || "5m",
  };
}

export async function loadState(): Promise<PersistedState | null> {
  await readyDb();
  const agents = await query<AgentRow>("SELECT * FROM agents");
  if (agents.length === 0) return null;

  const trades = await query<TradeRow>(
    "SELECT * FROM trades ORDER BY ts DESC, id DESC LIMIT 20000",
  );
  const db = getPool();
  const [maxRows] = await db.query<RowDataPacket[]>("SELECT MAX(id) AS id FROM equity_points");
  const maxId = Number(maxRows[0]?.id ?? 0);
  const [pointRows] = maxId
    ? await db.query<EquityRow[]>(
        "SELECT agent_id, ts, equity FROM equity_points WHERE id > ? ORDER BY agent_id, ts",
        [Math.max(0, maxId - 250_000)],
      )
    : [[] as EquityRow[]];
  const points = pointRows;
  const started = await query<MetaRow>("SELECT v FROM meta WHERE k = 'started_at'");

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

export async function saveState(state: PersistedState) {
  await readyDb();
  const db = getPool();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO meta (k, v) VALUES ('started_at', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
      [state.startedAt == null ? "" : String(state.startedAt)],
    );

    for (let i = 0; i < state.agents.length; i += 40) {
      await upsertAgents(conn, state.agents.slice(i, i + 40));
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
        `INSERT IGNORE INTO trades (id, agent_id, symbol, side, qty, price, fee, ts) VALUES ${slice
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
        `INSERT IGNORE INTO equity_points (agent_id, ts, equity) VALUES ${Array.from({ length: n }, () => "(?, ?, ?)").join(",")}`,
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

export async function insertAgent(agent: AgentRuntime) {
  await readyDb();
  await upsertAgent(getPool(), agent);
}

export async function insertAgents(agents: AgentRuntime[]) {
  if (agents.length === 0) return;
  await readyDb();
  const db = getPool();
  for (let i = 0; i < agents.length; i += 40) {
    await upsertAgents(db, agents.slice(i, i + 40));
  }
}

export async function deleteAgent(id: string) {
  await readyDb();
  const db = getPool();
  await db.query("DELETE FROM equity_points WHERE agent_id = ?", [id]);
  await db.query("DELETE FROM trades WHERE agent_id = ?", [id]);
  await db.query("DELETE FROM agents WHERE id = ?", [id]);
}

export async function loadAgentTrades(agentId: string): Promise<Trade[]> {
  await readyDb();
  const [rows] = await getPool().query<TradeRow[]>(
    "SELECT id, agent_id, symbol, side, qty, price, fee, ts FROM trades WHERE agent_id = ? ORDER BY ts ASC",
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

/** Per-agent fill counts from MySQL (not the in-memory ring). */
export async function countTradesByAgent(): Promise<Record<string, number>> {
  await readyDb();
  const [rows] = await getPool().query<(RowDataPacket & { agent_id: string; n: number | string })[]>(
    "SELECT agent_id, COUNT(*) AS n FROM trades GROUP BY agent_id",
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.agent_id)] = Number(row.n);
  return out;
}

export async function insertTrade(trade: Trade) {
  await readyDb();
  await getPool().query(
    `INSERT IGNORE INTO trades (id, agent_id, symbol, side, qty, price, fee, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trade.id,
      trade.agentId,
      trade.symbol,
      trade.side,
      trade.qty,
      trade.price,
      trade.fee,
      trade.ts,
    ],
  );
}

export async function resetPortfolios() {
  await readyDb();
  const db = getPool();
  await db.query("DELETE FROM equity_points");
  await db.query("DELETE FROM trades");
  await db.query("DELETE FROM meta");
  await db.query(
    `UPDATE agents
     SET usdt = starting_usdt,
         holdings = JSON_OBJECT(),
         last_signal = 'HOLD',
         last_error = NULL,
         last_symbol = NULL`,
  );
}

async function upsertAgents(
  conn: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  agents: AgentRuntime[],
) {
  if (agents.length === 0) return;
  const values = agents.flatMap(agentTuple);
  await conn.query(
    `INSERT INTO agents (
      id, strategy, symbol, starting_usdt, alloc_pct, base_alloc, params, usdt, holdings,
      last_signal, last_error, last_symbol, status, born_at, btc_at_birth, trade_interval
    ) VALUES ${agents.map(() => "(?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",")}
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
    values,
  );
}

function agentTuple(agent: AgentRuntime) {
  return [
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
  ];
}

async function upsertAgent(
  conn: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  agent: AgentRuntime,
) {
  await upsertAgents(conn, [agent]);
}

function parseJson<T>(value: T | string, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
