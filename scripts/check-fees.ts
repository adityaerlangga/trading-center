import { readFileSync } from "node:fs";
import { loadBinanceFees } from "../src/lib/market/fees";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
}

async function main() {
  const book = await loadBinanceFees();
  const samples = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];
  console.log(
    JSON.stringify(
      {
        source: book.source,
        label: book.label,
        defaultTaker: book.defaultTaker,
        symbolCount: Object.keys(book.bySymbol).length,
        samples: Object.fromEntries(samples.map((s) => [s, book.bySymbol[s] ?? null])),
        uniqueTakers: [...new Set(Object.values(book.bySymbol))].sort((a, b) => a - b),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
