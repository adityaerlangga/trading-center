import { takerFee, type FeeBook } from "../market/fees";
import { executeMarket, holdingQty } from "../paper/broker";
import { atr } from "../strategies/indicators";
import { getStrategy, runDecision } from "../strategies/index";
import type { Candle, EquityPoint, Trade } from "../types";
import { buildScanContext, higherSeries, volTargetWeight } from "./context";

export function simulateWindow(opts: {
  symbols: string[];
  candles: Record<string, Candle[]>;
  from: number;
  to: number;
  strategy: string;
  fees: FeeBook;
  starting: number;
  allocPct: number;
  interval: string;
}): { equity: EquityPoint[]; trades: Trade[] } {
  const strategy = getStrategy(opts.strategy);
  const portfolio = { usdt: opts.starting, holdings: {} as Record<string, number> };
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  const params = { ...strategy.defaults };

  for (let i = opts.from; i < opts.to; i += 1) {
    const book: Record<string, Candle[]> = {};
    for (const symbol of opts.symbols) {
      const series = opts.candles[symbol] ?? [];
      if (series.length > i) book[symbol] = series.slice(0, i + 1);
    }
    const scan = buildScanContext(book);
    const sells: string[] = [];
    const buys: { symbol: string; score: number }[] = [];

    for (const symbol of opts.symbols) {
      const series = book[symbol];
      if (!series || series.length < 30) continue;
      const decision = runDecision(strategy, {
        candles: series,
        higher: higherSeries(series, opts.interval),
        portfolio,
        symbol,
        params,
        rank: scan.ranks[symbol],
        universeSize: scan.universeSize,
        btcReturn: scan.btcReturn,
        regime: scan.regime,
      });
      if (decision.signal === "SELL" && holdingQty(portfolio, symbol) > 0) sells.push(symbol);
      if (decision.signal === "BUY" && holdingQty(portfolio, symbol) === 0) {
        buys.push({ symbol, score: decision.score ?? 0 });
      }
    }

    const ts = opts.candles.BTCUSDT?.[i]?.closeTime ?? opts.candles[opts.symbols[0]]?.[i]?.closeTime ?? i;
    for (const symbol of sells) {
      const price = book[symbol]?.at(-1)?.close;
      if (!price) continue;
      const trade = executeMarket({
        agentId: "research",
        symbol,
        side: "SELL",
        price,
        feeRate: takerFee(opts.fees, symbol),
        portfolio,
        sizePct: 1,
      });
      if (trade) {
        trade.ts = ts;
        trades.push(trade);
      }
    }

    buys.sort((a, b) => b.score - a.score);
    for (const buy of buys) {
      const series = book[buy.symbol] ?? [];
      const price = series.at(-1)?.close;
      if (!price || portfolio.usdt < 10) continue;
      const mark = markEquity(portfolio, book);
      const atrVal = atr(series, 14);
      const atrPct = atrVal && price ? atrVal / price : 0;
      const weight = volTargetWeight(opts.allocPct, atrPct);
      const target = mark * weight;
      if (target < 10) continue;
      const trade = executeMarket({
        agentId: "research",
        symbol: buy.symbol,
        side: "BUY",
        price,
        feeRate: takerFee(opts.fees, buy.symbol),
        portfolio,
        sizePct: Math.min(1, target / portfolio.usdt),
      });
      if (trade) {
        trade.ts = ts;
        trades.push(trade);
      }
    }

    equity.push({ ts, equity: markEquity(portfolio, book) });
  }

  return { equity, trades };
}

function markEquity(
  portfolio: { usdt: number; holdings: Record<string, number> },
  book: Record<string, Candle[]>,
) {
  let equity = portfolio.usdt;
  for (const [asset, qty] of Object.entries(portfolio.holdings)) {
    const symbol = asset.endsWith("USDT") ? asset : `${asset}USDT`;
    equity += qty * (book[symbol]?.at(-1)?.close ?? 0);
  }
  return equity;
}

export function btcReturnPct(candles: Candle[], from: number, to: number) {
  const start = candles[from]?.close;
  const end = candles[to - 1]?.close;
  if (!start || !end) return 0;
  return (end / start - 1) * 100;
}
