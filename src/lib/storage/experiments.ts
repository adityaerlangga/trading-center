import type { RowDataPacket } from "mysql2/promise";
import type { ResearchMetrics } from "../research/metrics";
import { ensureSchema, getPool, query } from "./mysql";

export type StoredReport = {
  id: string;
  strategy: string;
  interval: string;
  symbols: string[];
  folds: ResearchMetrics[];
  aggregate: ResearchMetrics;
  passed: boolean;
};

type ExperimentRow = RowDataPacket & {
  id: string;
  strategy: string;
  interval: string;
  universe_n: number;
  created_at: number;
  passed: number;
  summary: StoredReport | string;
};

export async function saveExperiment(report: StoredReport) {
  await ensureSchema();
  const db = getPool();
  await db.query(
    `INSERT INTO experiments (id, strategy, \`interval\`, universe_n, created_at, passed, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      report.id,
      report.strategy,
      report.interval,
      report.symbols.length,
      Date.now(),
      report.passed ? 1 : 0,
      JSON.stringify(report),
    ],
  );
  for (let fold = 0; fold < report.folds.length; fold += 1) {
    await db.query(
      `INSERT INTO experiment_runs (experiment_id, fold, metrics) VALUES (?, ?, ?)`,
      [report.id, fold, JSON.stringify(report.folds[fold])],
    );
  }
}

export async function listExperiments(limit = 12): Promise<StoredReport[]> {
  await ensureSchema();
  const rows = await query<ExperimentRow>(
    `SELECT id, strategy, \`interval\`, universe_n, created_at, passed, summary
     FROM experiments ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`,
  );
  return rows.map((row) => parseReport(row.summary, row));
}

export async function getExperiment(id: string): Promise<StoredReport | null> {
  await ensureSchema();
  const db = getPool();
  const [rows] = await db.query<ExperimentRow[]>(
    "SELECT id, strategy, `interval`, universe_n, created_at, passed, summary FROM experiments WHERE id = ? LIMIT 1",
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return parseReport(row.summary, row);
}

function parseReport(summary: StoredReport | string, row: ExperimentRow): StoredReport {
  const parsed = typeof summary === "string" ? (JSON.parse(summary) as StoredReport) : summary;
  return {
    ...parsed,
    id: row.id,
    passed: Boolean(row.passed),
    aggregate: parsed.aggregate ?? emptyMetrics(),
    folds: parsed.folds ?? [],
    symbols: parsed.symbols ?? [],
  };
}

function emptyMetrics(): ResearchMetrics {
  return {
    returnPct: 0,
    sharpe: 0,
    maxDrawdownPct: 0,
    profitFactor: 0,
    turnover: 0,
    trades: 0,
    btcReturnPct: 0,
    excessVsBtc: 0,
    passed: false,
    reason: "",
  };
}
