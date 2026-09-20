import { runResearch } from "./research/walkforward";

async function main() {
  console.log("Walk-forward lab (1h, top 12). For options: npm run research -- --strategy tsmom_atr\n");
  const report = await runResearch({
    strategy: process.argv[2] ?? "tsmom_atr",
    interval: "1h",
    limit: 12,
    persist: false,
  });
  console.log(
    `${report.passed ? "PASS" : "FAIL"} ${report.strategy}: excess ${report.aggregate.excessVsBtc.toFixed(2)}% · ${report.aggregate.reason}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
