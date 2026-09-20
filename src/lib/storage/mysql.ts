import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";

let pool: Pool | null = null;

export function dbConfig() {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "",
    database: process.env.MYSQL_DATABASE ?? "trading_center",
  };
}

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...dbConfig(),
      waitForConnections: true,
      connectionLimit: 8,
      namedPlaceholders: true,
    });
  }
  return pool;
}

export async function ensureSchema() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS meta (
      k VARCHAR(64) PRIMARY KEY,
      v TEXT NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR(64) PRIMARY KEY,
      strategy VARCHAR(64) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      starting_usdt DECIMAL(18,2) NOT NULL,
      params JSON NOT NULL,
      usdt DECIMAL(18,8) NOT NULL,
      holdings JSON NOT NULL,
      last_signal VARCHAR(8) NOT NULL,
      last_error TEXT NULL,
      last_symbol VARCHAR(32) NULL,
      alloc_pct DECIMAL(8,4) NOT NULL DEFAULT 0.10,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await db.query(`ALTER TABLE agents ADD COLUMN last_symbol VARCHAR(32) NULL`).catch(() => undefined);
  await db.query(
    `ALTER TABLE agents ADD COLUMN alloc_pct DECIMAL(8,4) NOT NULL DEFAULT 0.10`,
  ).catch(() => undefined);
  await db.query(`ALTER TABLE agents MODIFY symbol VARCHAR(32) NULL`).catch(() => undefined);
  await db.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id CHAR(36) PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      symbol VARCHAR(32) NOT NULL,
      side ENUM('BUY','SELL') NOT NULL,
      qty DECIMAL(18,8) NOT NULL,
      price DECIMAL(18,8) NOT NULL,
      fee DECIMAL(18,8) NOT NULL,
      ts BIGINT NOT NULL,
      INDEX idx_trades_agent_ts (agent_id, ts),
      INDEX idx_trades_ts (ts)
    )
  `);
  await db.query(`ALTER TABLE agents ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active'`).catch(
    () => undefined,
  );
  await db.query(`ALTER TABLE agents ADD COLUMN born_at BIGINT NULL`).catch(() => undefined);
  await db.query(`ALTER TABLE agents ADD COLUMN btc_at_birth DECIMAL(18,8) NULL`).catch(() => undefined);
  await db.query(`ALTER TABLE agents ADD COLUMN trade_interval VARCHAR(8) NULL`).catch(() => undefined);
  await db.query(`
    CREATE TABLE IF NOT EXISTS experiments (
      id CHAR(36) PRIMARY KEY,
      strategy VARCHAR(64) NOT NULL,
      \`interval\` VARCHAR(8) NOT NULL,
      universe_n INT NOT NULL,
      created_at BIGINT NOT NULL,
      passed TINYINT NOT NULL,
      summary JSON NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS experiment_runs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      experiment_id CHAR(36) NOT NULL,
      fold INT NOT NULL,
      metrics JSON NOT NULL,
      INDEX idx_runs_experiment (experiment_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS equity_points (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      ts BIGINT NOT NULL,
      equity DECIMAL(18,2) NOT NULL,
      UNIQUE KEY uniq_equity_agent_ts (agent_id, ts),
      INDEX idx_equity_agent_ts (agent_id, ts)
    )
  `);
}

export async function query<T extends RowDataPacket>(sql: string) {
  const [rows] = await getPool().query<T[]>(sql);
  return rows;
}
