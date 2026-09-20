import { readFileSync } from "node:fs";
import { getPool } from "../src/lib/storage/mysql";
import { runResearch } from "../src/lib/research/walkforward";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const strategy = arg("--strategy") ?? "tsmom_atr";
  const interval = arg("--interval") ?? "1h";
  const limit = Number(arg("--limit") ?? 24);
  console.log(`Research ${strategy} · ${interval} · top ${limit} USDT\n`);
  const report = await runResearch({ strategy, interval, limit });
  for (let i = 0; i < report.folds.length; i += 1) {
    const fold = report.folds[i];
    console.log(
      `fold ${i + 1}: ret ${fold.returnPct.toFixed(2)}% · btc ${fold.btcReturnPct.toFixed(2)}% · sharpe ${fold.sharpe.toFixed(2)} · dd ${fold.maxDrawdownPct.toFixed(1)}% · turn ${fold.turnover.toFixed(1)}x · ${fold.passed ? "PASS" : "FAIL"}`,
    );
  }
  const agg = report.aggregate;
  console.log(
    `\n${report.passed ? "PASS" : "FAIL"} ${strategy}: ret ${agg.returnPct.toFixed(2)}% vs btc ${agg.btcReturnPct.toFixed(2)}% · excess ${agg.excessVsBtc.toFixed(2)}% · maxDD ${agg.maxDrawdownPct.toFixed(1)}% · ${agg.reason}`,
  );
  console.log(`experiment ${report.id}`);
  await getPool().end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
