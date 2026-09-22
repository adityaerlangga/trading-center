import { isPegged, loadConfig, slugify, toSymbol } from "./config";
import { parseMoney } from "./money";
import { emptyFeeBook, loadBinanceFees, PPH22_FOREIGN_SELL, takerFee, type FeeBook } from "./market/fees";
import { fetchAllBookTickers, fetchKlinesBatch } from "./market/rest";
import { fetchTopUsdtByVolume, fetchUsdtUniverse } from "./market/universe";
import { BinanceWebSocket, type KlineSub } from "./market/ws";
import { executeMarket, holdingQty } from "./paper/broker";
import { midPrice, roundUsd } from "./paper/math";
import {
  deleteAgent as deleteAgentRow,
  insertAgent,
  insertAgents,
  insertTrade,
  loadState,
  loadAgentTrades,
  resetPortfolios,
  saveState,
} from "./storage/store";
import { sampleRoster } from "./league/samples";
import { sharpeRatio } from "./research/metrics";
import { btcRegime, buildScanContext, higherSeries, volTargetWeight } from "./research/context";
import { atr, chandelierStop } from "./strategies/indicators";
import { getStrategy, listScannerStrategies, runDecision } from "./strategies/index";
import type {
  AgentRuntime,
  AgentThought,
  AgentView,
  AppConfig,
  BookTicker,
  Candle,
  CreateAgentInput,
  EquityPoint,
  FeedStatus,
  PositionView,
  PositionTone,
  Snapshot,
  Thought,
  Trade,
  LeagueRow,
} from "./types";

const MAX_TRADES = 400;
const MAX_EQUITY = 400;

const SEED_AGENTS: AgentRuntime[] = [
  {
    id: "sma_scanner",
    strategy: "sma_crossover",
    startingUsdt: 10000,
    allocPct: 0.1,
    baseAlloc: 0.1,
    params: { fast: 9, slow: 21 },
    usdt: 10000,
    holdings: {},
    lastSignal: "HOLD",
    status: "active",
    bornAt: 0,
    btcAtBirth: 0,
    interval: "5m",
  },
  {
    id: "rsi_scanner",
    strategy: "rsi_mean_reversion",
    startingUsdt: 10000,
    allocPct: 0.1,
    baseAlloc: 0.1,
    params: { period: 14, oversold: 30, overbought: 70 },
    usdt: 10000,
    holdings: {},
    lastSignal: "HOLD",
    status: "active",
    bornAt: 0,
    btcAtBirth: 0,
    interval: "5m",
  },
];

export class PaperEngine {
  config: AppConfig | null = null;
  universe: string[] = [];
  running = false;
  starting = false;
  stoppedByUser = false;
  startedAt: number | null = null;
  feed: FeedStatus = emptyFeed();
  quotes: Record<string, BookTicker> = {};
  candles: Record<string, Candle[]> = {};
  books: Record<string, Record<string, Candle[]>> = {};
  liquid: string[] = [];
  agents: AgentRuntime[] = [];
  trades: Trade[] = [];
  equity: Record<string, EquityPoint[]> = {};
  fees: FeeBook = emptyFeeBook();

  private feedClient: BinanceWebSocket | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private quoteTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCloses = new Map<string, Set<string>>();
  private lastEquityTs = 0;
  private lastLeagueTs = 0;
  private persisting = false;
  private equityMark = new Map<string, number>();
  protected thoughts = new Map<string, AgentThought>();

  snapshot(): Snapshot {
    this.maybeBackfillScan();
    const agents = this.agents.map((agent) => this.view(agent));
    const btcReturnPct = this.btcReturnPct();
    const league = this.leagueRows(agents, btcReturnPct);
    const shown = new Set(league.slice(0, 12).map((row) => row.id));
    const visible = agents
      .filter((agent) => shown.has(agent.id))
      .map((agent) => ({
        ...agent,
        thought: { ...agent.thought, notes: [], topBuys: [] },
      }));
    const equity: Record<string, EquityPoint[]> = {};
    for (const id of shown) equity[id] = (this.equity[id] ?? []).slice(-40);
    return {
      mode: this.config?.mode ?? "paper",
      running: this.running,
      starting: this.starting,
      startedAt: this.startedAt,
      interval: this.config?.interval ?? "5m",
      feeRate: this.fees.defaultTaker,
      feeLabel: this.fees.label,
      feed: this.feed,
      quotes: this.quotesFor(visible),
      agents: visible,
      trades: this.trades.slice(-80).reverse(),
      equity,
      btcReturnPct,
      regime: this.currentRegime(),
      league,
    };
  }

  agentDetail(id: string) {
    const agent = this.agents.find((row) => row.id === id);
    if (!agent) return null;
    return this.agentDetailFrom(agent, this.trades.filter((trade) => trade.agentId === id));
  }

  async agentDetailFull(id: string) {
    const agent = this.agents.find((row) => row.id === id);
    if (!agent) return null;
    const trades = await this.loadTradesFor(id);
    return this.agentDetailFrom(agent, trades);
  }

  protected async loadTradesFor(id: string) {
    return loadAgentTrades(id);
  }

  private agentDetailFrom(agent: AgentRuntime, trades: Trade[]) {
    const positions = this.positionsOf(agent, trades);
    const view = this.view(agent);
    return {
      ...view,
      positions,
      positionCount: positions.length,
      trades: [...trades].sort((a, b) => b.ts - a.ts).slice(0, 80),
      equitySeries: this.equity[agent.id] ?? [],
    };
  }

  async start() {
    if (this.running || this.starting) return;
    this.stoppedByUser = false;
    this.starting = true;
    this.feed = emptyFeed();

    try {
      this.config = this.loadDeskConfig();
      await this.beforeStart();
      await this.refreshFees();
      await this.loadAgents();
      await this.ensureSamples();
      this.universe = await fetchUsdtUniverse();
      this.liquid = await fetchTopUsdtByVolume(24).catch(() => this.universe.slice(0, 24));
      this.feed = {
        ...this.feed,
        universe: this.universe.length,
        warmupTotal: this.warmupJobs(),
      };
      this.connectFeed();
      this.startQuotePoll();
      await this.warmup();
      this.startedAt ??= Date.now();
      this.running = true;
      this.persistTimer = setInterval(() => {
        void this.persist();
        this.tickLeague();
        if (Date.now() - this.fees.fetchedAt > 60 * 60_000) {
          void this.refreshFees();
        }
      }, 10_000);
      await this.persist();
    } catch (error) {
      this.feed = {
        ...this.feed,
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    this.stoppedByUser = true;
      this.feedClient?.stop();
      this.feedClient = null;
      this.stopQuotePoll();
    if (this.persistTimer) clearInterval(this.persistTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.persistTimer = null;
    this.flushTimer = null;
    this.running = false;
    this.feed = { ...this.feed, connected: false };
    await this.persist();
  }

  async reset() {
    await this.stop();
    await this.resetDeskPortfolios();
    this.quotes = {};
      this.candles = {};
      this.books = {};
      this.liquid = [];
    this.trades = [];
    this.equity = {};
    this.startedAt = null;
    this.pendingCloses.clear();
    this.thoughts.clear();
    await this.start();
  }

  protected loadDeskConfig(): AppConfig {
    return loadConfig();
  }

  protected async beforeStart() {
    // paper: no extra gate
  }

  protected async resetDeskPortfolios() {
    await resetPortfolios();
  }

  async createAgent(input: CreateAgentInput) {
    const strategy = getStrategy(input.strategy);
    const id = slugify(input.id ?? input.name ?? "");
    if (this.agents.some((agent) => agent.id === id)) {
      throw new Error(`Agent ${id} already exists`);
    }
    const startingUsdt = parseMoney(input.startingUsdt);
    if (!Number.isFinite(startingUsdt) || startingUsdt <= 0) {
      throw new Error("startingUsdt must be > 0");
    }
    const agent: AgentRuntime = {
      id,
      strategy: strategy.name,
      startingUsdt,
      allocPct: clampAlloc(input.allocPct ?? 0.2),
      baseAlloc: clampAlloc(input.allocPct ?? 0.2),
      params: { ...strategy.defaults, ...input.params },
      usdt: startingUsdt,
      holdings: {},
      lastSignal: "HOLD",
      status: "active",
      bornAt: Date.now(),
      btcAtBirth: this.btcPrice(),
      interval: input.interval || this.config?.interval || "5m",
    };
    this.agents.push(agent);
    this.equity[id] = [];
    await this.persistAgent(agent);
    const warmed = this.feed.warmupTotal > 0 && this.feed.warmupDone >= this.feed.warmupTotal;
    if (warmed && this.universe.length > 0) {
      this.note(id, {
        action: "scan",
        reason: `Agent baru. Langsung scan ${this.universeFor(agent).length} pair. Interval ${agent.interval}.`,
      });
      void this.scanOne(agent, this.universeFor(agent));
    } else {
      this.note(id, {
        action: "wait",
        reason: "Warmup klines belum selesai. Agent antri, belum pilih coin.",
      });
    }
    return this.view(agent);
  }

  async updateAgent(id: string, patch: { startingUsdt?: number | string; allocPct?: number }) {
    const agent = this.agents.find((row) => row.id === id);
    if (!agent) throw new Error("Agent not found");
    if (patch.startingUsdt != null) {
      const startingUsdt = parseMoney(patch.startingUsdt);
      if (!Number.isFinite(startingUsdt) || startingUsdt <= 0) {
        throw new Error("startingUsdt must be > 0");
      }
      const hasPosition = Object.values(agent.holdings).some((qty) => qty > 0);
      if (!hasPosition) {
        agent.usdt = startingUsdt;
      }
      agent.startingUsdt = startingUsdt;
    }
    if (patch.allocPct != null) {
      agent.allocPct = clampAlloc(patch.allocPct);
    }
    await this.persistAgent(agent);
    return this.view(agent);
  }

  async removeAgent(id: string) {
    this.agents = this.agents.filter((agent) => agent.id !== id);
    this.trades = this.trades.filter((trade) => trade.agentId !== id);
    delete this.equity[id];
    this.thoughts.delete(id);
    await this.deletePersistedAgent(id);
  }

  strategies() {
    return listScannerStrategies();
  }

  protected async persistAgent(agent: AgentRuntime) {
    await insertAgent(agent);
  }

  protected async deletePersistedAgent(id: string) {
    await deleteAgentRow(id);
  }

  protected async persistAgents(agents: AgentRuntime[]) {
    await insertAgents(agents);
  }

  protected async persistTrade(trade: Trade) {
    await insertTrade(trade);
  }

  private async refreshFees() {
    try {
      this.fees = await loadBinanceFees();
    } catch (error) {
      console.error("failed to load Binance fees", error);
      this.fees = emptyFeeBook();
    }
    if (this.fees.fetchedAt === 0) this.fees.fetchedAt = Date.now();
  }

  protected async loadAgents() {
    const saved = await this.loadDeskState();
    if (saved && saved.agents.length > 0) {
      this.agents = saved.agents
        .map((agent): AgentRuntime => ({
          ...agent,
          strategy:
            agent.strategy === "buy_and_hold" ? "sma_crossover" : agent.strategy,
          allocPct: agent.allocPct > 0 ? agent.allocPct : 0.1,
          baseAlloc: agent.baseAlloc > 0 ? agent.baseAlloc : agent.allocPct || 0.1,
          status: agent.status === "killed" ? "killed" : "active",
          bornAt: agent.bornAt || this.startedAt || Date.now(),
          btcAtBirth: agent.btcAtBirth || 0,
        }))
        .filter((agent) => {
          try {
            getStrategy(agent.strategy);
            return true;
          } catch {
            return false;
          }
        });
      if (this.agents.length === 0) {
        this.agents = this.defaultAgents();
      }
      this.trades = saved.trades;
      this.equity = saved.equity;
      this.startedAt = saved.startedAt;
      this.rememberEquityMarks();
      for (const agent of this.agents) this.releasePegs(agent);
      return;
    }
    this.agents = this.defaultAgents();
    this.trades = [];
    this.equity = Object.fromEntries(this.agents.map((agent) => [agent.id, []]));
  }

  protected defaultAgents(): AgentRuntime[] {
    return SEED_AGENTS.map((agent) => ({ ...agent, holdings: {} }));
  }

  protected async loadDeskState() {
    return loadState();
  }

  protected async saveDeskState(state: Parameters<typeof saveState>[0]) {
    await saveState(state);
  }

  protected async ensureSamples() {
    const existing = new Set(this.agents.map((agent) => agent.id));
    const fresh: AgentRuntime[] = [];
    for (const spec of sampleRoster()) {
      if (existing.has(spec.id)) continue;
      const strategy = getStrategy(spec.strategy);
      const agent: AgentRuntime = {
        id: spec.id,
        strategy: strategy.name,
        startingUsdt: 100,
        allocPct: 0.1,
        baseAlloc: 0.1,
        params: { ...strategy.defaults, ...spec.params, liquid: 1 },
        usdt: 100,
        holdings: {},
        lastSignal: "HOLD",
        status: "active",
        bornAt: Date.now(),
        btcAtBirth: 0,
        interval: spec.interval,
      };
      fresh.push(agent);
      this.agents.push(agent);
      this.equity[agent.id] ??= [];
    }
    if (fresh.length === 0) return;
    await this.persistAgents(fresh);
    console.log(`seeded ${fresh.length} speed-trading agents at $100`);
  }

  private async warmup() {
    if (!this.config) return;
    const jobs = this.warmupJobs();
    let done = 0;
    this.books = {};
    for (const interval of this.activeIntervals()) {
      const symbols = this.symbolsForInterval(interval);
      const limit = interval === "1s" ? 180 : 120;
      const batch = await fetchKlinesBatch(symbols, interval, limit, () => {
        done += 1;
        this.feed = { ...this.feed, warmupDone: Math.min(done, jobs), warmupTotal: jobs };
      });
      this.books[interval] = batch;
    }
    this.candles = this.books[this.config.interval] ?? {};
    this.feed = { ...this.feed, warmupDone: jobs, warmupTotal: jobs };
    this.scanAll();
    this.recordEquity(true);
  }

  private startQuotePoll() {
    const pull = () => {
      void fetchAllBookTickers()
        .then((rows) => {
          for (const quote of rows) {
            if (quote.bid > 0 && quote.ask > 0) this.quotes[quote.symbol] = quote;
          }
        })
        .catch((error) => {
          console.error("book ticker poll failed", error);
        });
    };
    pull();
    this.stopQuotePoll();
    this.quoteTimer = setInterval(pull, 2000);
  }

  private stopQuotePoll() {
    if (!this.quoteTimer) return;
    clearInterval(this.quoteTimer);
    this.quoteTimer = null;
  }

  private connectFeed() {
    if (!this.config) return;
    this.feedClient?.stop();
    const subs: KlineSub[] = [];
    for (const interval of this.activeIntervals()) {
      for (const symbol of this.symbolsForInterval(interval)) {
        subs.push({ symbol, interval });
      }
    }
    this.feedClient = new BinanceWebSocket(subs, {
      onQuote: (quote) => {
        this.quotes[quote.symbol] = quote;
        if (Date.now() - this.lastEquityTs > 15_000) this.recordEquity();
      },
      onKline: (symbol, interval, candle) => {
        this.applyKline(interval, symbol, candle);
      },
      onStatus: (status) => {
        this.feed = {
          ...status,
          universe: this.universe.length,
          warmupDone: this.feed.warmupDone,
          warmupTotal: this.feed.warmupTotal || this.universe.length,
        };
      },
    });
    this.feedClient.start();
  }

  private applyKline(interval: string, symbol: string, candle: Candle) {
    const book = (this.books[interval] ??= {});
    const series = book[symbol] ?? [];
    const last = series.at(-1);
    const cap = interval === "1s" ? 240 : 150;
    if (last && last.openTime === candle.openTime) {
      series[series.length - 1] = candle;
    } else {
      series.push(candle);
      if (series.length > cap) series.splice(0, series.length - cap);
    }
    book[symbol] = series;
    if (interval === (this.config?.interval ?? "5m")) this.candles = book;
    if (candle.isClosed) {
      const pending = this.pendingCloses.get(interval) ?? new Set<string>();
      pending.add(symbol);
      this.pendingCloses.set(interval, pending);
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flushCloses(), interval === "1s" ? 400 : 800);
    }
  }

  private flushCloses() {
    const pending = this.pendingCloses;
    this.pendingCloses = new Map();
    if (pending.size === 0) return;
    for (const [interval, symbols] of pending) {
      for (const agent of this.agents) {
        if (agent.status === "killed" || this.agentInterval(agent) !== interval) continue;
        const scope = agent.params.liquid ? this.universeFor(agent) : [...symbols];
        void this.scanOne(agent, scope);
      }
    }
    this.recordEquity();
  }

  protected agentInterval(agent: AgentRuntime) {
    return agent.interval || this.config?.interval || "5m";
  }

  private activeIntervals() {
    const intervals = new Set<string>([this.config?.interval ?? "5m"]);
    for (const agent of this.agents) {
      if (agent.status !== "killed") intervals.add(this.agentInterval(agent));
    }
    return [...intervals];
  }

  private symbolsForInterval(interval: string) {
    const users = this.agents.filter(
      (agent) => agent.status !== "killed" && this.agentInterval(agent) === interval,
    );
    if (users.some((agent) => !agent.params.liquid)) return this.universe;
    return this.liquid.length > 0 ? this.liquid : this.universe.slice(0, 24);
  }

  protected universeFor(agent: AgentRuntime) {
    if (agent.params.liquid) return this.symbolsForInterval(this.agentInterval(agent));
    return this.universe;
  }

  private warmupJobs() {
    return this.activeIntervals().reduce((sum, interval) => sum + this.symbolsForInterval(interval).length, 0);
  }

  protected series(interval: string) {
    return this.books[interval] ?? (interval === (this.config?.interval ?? "5m") ? this.candles : {});
  }

  protected lastClose(symbol: string) {
    for (const interval of ["1s", "1m", "3m", "5m", "15m", "1h", this.config?.interval ?? "5m"]) {
      const close = this.books[interval]?.[symbol]?.at(-1)?.close ?? this.candles[symbol]?.at(-1)?.close;
      if (close) return close;
    }
    return 0;
  }

  private markPrice(symbol: string) {
    const quote = this.quotes[symbol];
    return quote?.bid || quote?.ask || this.lastClose(symbol);
  }

  private scanAll() {
    for (const agent of this.agents) {
      if (agent.status === "killed") continue;
      void this.scanOne(agent, this.universeFor(agent));
    }
  }

  private scanSymbols(symbols: string[]) {
    if (!this.config) return;
    for (const agent of this.agents) {
      if (agent.status === "killed") continue;
      const scope = agent.params.liquid ? this.universeFor(agent) : symbols;
      void this.scanOne(agent, scope);
    }
  }

  protected async scanOne(agent: AgentRuntime, symbols: string[]) {
    if (!this.config) return;
    try {
      const strategy = getStrategy(agent.strategy);
      const limits = riskLimits(agent);
      const params = { ...strategy.defaults, ...agent.params };
      const held = Object.keys(agent.holdings).map(toSymbol);
      const scanSet = [...new Set([...symbols, ...held])];
      const interval = this.agentInterval(agent);
      const source = this.series(interval);
      const book: Record<string, Candle[]> = {};
      for (const symbol of scanSet) {
        book[symbol] = (source[symbol] ?? []).filter((candle) => candle.isClosed);
      }
      const scan = buildScanContext(book, Number(params.lookback ?? 24));
      const sells: { symbol: string; reason: string }[] = [];
      const buys: { symbol: string; score: number; reason: string }[] = [];
      let scanned = 0;

      for (const symbol of scanSet) {
        const closed = book[symbol] ?? [];
        if (closed.length === 0) continue;
        scanned += 1;
        const decision = runDecision(strategy, {
          candles: closed,
          higher: higherSeries(closed, interval),
          portfolio: agent,
          symbol,
          params,
          rank: scan.ranks[symbol],
          universeSize: scan.universeSize,
          btcReturn: scan.btcReturn,
          regime: scan.regime,
        });
        if (decision.signal === "SELL" && holdingQty(agent, symbol) > 0) {
          sells.push({ symbol, reason: decision.reason });
        }
        if (decision.signal === "BUY" && holdingQty(agent, symbol) === 0) {
          buys.push({ symbol, score: decision.score ?? 0, reason: decision.reason });
        }
        if (holdingQty(agent, symbol) > 0 && !sells.some((row) => row.symbol === symbol)) {
          const stop = chandelierStop(closed, limits.atrPeriod, limits.chanLookback, limits.atrMult);
          const close = closed.at(-1)?.close;
          if (stop != null && close != null && close < stop) {
            sells.push({
              symbol,
              reason: `${symbol}: overlay chandelier ATR — ${close.toFixed(6)} < ${stop.toFixed(6)} (Wilder)`,
            });
          }
          const hardStopPct = Number(params.hardStopPct ?? 0);
          const takeProfitPct = Number(params.takeProfitPct ?? 0);
          if ((hardStopPct > 0 || takeProfitPct > 0) && close != null && !sells.some((row) => row.symbol === symbol)) {
            const lot = openLot(
              this.trades.filter((trade) => trade.agentId === agent.id),
              symbol,
              holdingQty(agent, symbol),
            );
            if (lot.entryPrice > 0) {
              const dd = (close - lot.entryPrice) / lot.entryPrice;
              if (hardStopPct > 0 && dd <= -hardStopPct) {
                sells.push({
                  symbol,
                  reason: `${symbol}: hard stop ${(dd * 100).toFixed(2)}% ≤ -${(hardStopPct * 100).toFixed(1)}% dari entry ${lot.entryPrice.toFixed(6)}`,
                });
              } else if (takeProfitPct > 0 && dd >= takeProfitPct) {
                sells.push({
                  symbol,
                  reason: `${symbol}: take profit ${(dd * 100).toFixed(2)}% ≥ +${(takeProfitPct * 100).toFixed(1)}% dari entry ${lot.entryPrice.toFixed(6)}`,
                });
              }
            }
          }
        }
      }

      const maxPositions = Number(params.maxPositions ?? 0);
      this.note(agent.id, {
        action: "scan",
        reason: `Scan ${scanned} pair. Watchlist beli ${buys.length}, sinyal jual ${sells.length}. ${
          maxPositions > 0 ? `Maks ${maxPositions} posisi` : "Posisi tidak dibatasi"
        }; entry hanya yang lolos filter.`,
      });

      for (const sell of sells) {
        const filled = await this.fill(agent, sell.symbol, "SELL", 1);
        this.note(agent.id, {
          action: filled ? "sell" : "skip",
          symbol: sell.symbol,
          reason: filled ? sell.reason : `${sell.reason} — fill gagal`,
        });
      }

      buys.sort((a, b) => b.score - a.score);
      const qualified = buys.filter((buy) => buy.score >= limits.minScore);
      const thought = this.ensureThought(agent.id);
      thought.topBuys = qualified.slice(0, 8);
      thought.scanned = scanned;
      thought.buySignals = qualified.length;
      thought.sellSignals = sells.length;
      thought.lastScanAt = Date.now();
      thought.nextCandleAt = this.nextCandleAt(interval);
      thought.status = "waiting";

      let filledBuys = 0;
      const startDelay = Number(params.startDelay ?? 0);
      const seen = Number(agent.params.scansSeen ?? 0) + 1;
      agent.params.scansSeen = seen;
      const waitingStart = seen <= startDelay;
      if (waitingStart) {
        this.note(agent.id, {
          action: "wait",
          reason: `Belum mulai beli. Scan ${seen}/${startDelay}, cash tetap dipegang sampai giliran start.`,
        });
      }
      const minTicket = this.config.mode === "live" ? 5 : 1;
      for (const buy of qualified) {
        if (waitingStart) break;
        if (maxPositions > 0 && materialPositions(agent, (symbol) => this.markPrice(symbol)) >= maxPositions) {
          this.note(agent.id, {
            action: "wait",
            symbol: buy.symbol,
            score: buy.score,
            reason: `${buy.symbol}: sudah ${maxPositions} posisi. Cash menunggu exit, tidak nambah.`,
          });
          break;
        }
        const equity = this.markEquity(agent);
        const series = (this.series(interval)[buy.symbol] ?? []).filter((candle) => candle.isClosed);
        const close = series.at(-1)?.close ?? 0;
        const atrVal = atr(series, 14);
        const weight = volTargetWeight(agent.allocPct, close && atrVal ? atrVal / close : 0);
        const target = equity * weight;

        if (isPegged(buy.symbol) || agent.usdt < minTicket || target < minTicket) {
          this.note(agent.id, {
            action: "wait",
            symbol: buy.symbol,
            score: buy.score,
            reason: isPegged(buy.symbol)
              ? `${buy.symbol}: stablecoin dilewati.`
              : agent.usdt < minTicket
                ? `${buy.symbol}: cash ${agent.usdt.toFixed(2)} di bawah minimum $${minTicket}.`
                : `${buy.symbol}: size ${target.toFixed(2)} USDT di bawah minimum $${minTicket}.`,
          });
          if (agent.usdt < minTicket || target < minTicket) break;
          continue;
        }

        const sizePct = Math.min(1, target / agent.usdt);
        const filled = await this.fill(agent, buy.symbol, "BUY", sizePct);
        this.note(agent.id, {
          action: filled ? "buy" : "skip",
          symbol: buy.symbol,
          score: buy.score,
          reason: filled
            ? `${buy.reason} — size ~${(weight * 100).toFixed(1)}% equity (vol target)`
            : `${buy.reason} — tidak terisi`,
        });
        if (filled) filledBuys += 1;
      }

      if (qualified.length === 0 && sells.length === 0) {
        this.note(agent.id, {
          action: "wait",
          reason: `Tidak ada setup yang lolos filter. Cash dipegang. Next candle ${interval} ${fmtClock(thought.nextCandleAt)}.`,
        });
      } else if (filledBuys === 0 && qualified.length > 0 && sells.length === 0) {
        this.note(agent.id, {
          action: "wait",
          reason: `${qualified.length} watchlist, 0 entry. Agent memilih hold cash sampai waktunya pas.`,
        });
      }

      thought.summary = this.summarize(agent.id, interval);
      agent.lastError = undefined;
    } catch (error) {
      agent.lastError = error instanceof Error ? error.message : String(error);
      this.note(agent.id, { action: "skip", reason: agent.lastError });
    }
  }

  private releasePegs(agent: AgentRuntime) {
    for (const asset of Object.keys(agent.holdings)) {
      if (!isPegged(asset)) continue;
      agent.usdt = roundUsd(agent.usdt + (agent.holdings[asset] ?? 0));
      delete agent.holdings[asset];
    }
  }

  protected currentRegime() {
    const candles =
      this.series("5m").BTCUSDT ??
      this.series("15m").BTCUSDT ??
      this.series("1h").BTCUSDT ??
      [];
    return btcRegime(candles);
  }

  protected async fill(agent: AgentRuntime, symbol: string, side: "BUY" | "SELL", sizePct: number) {
    if (!this.config) return false;
    if (side === "BUY" && isPegged(symbol)) return false;
    const quote = this.quotes[symbol];
    const last = this.lastClose(symbol);
    const price = side === "BUY" ? quote?.ask ?? last : quote?.bid ?? last;
    if (!price) return false;
    const trade = executeMarket({
      agentId: agent.id,
      symbol,
      side,
      price,
      feeRate: takerFee(this.fees, symbol),
      portfolio: agent,
      sizePct,
    });
    if (!trade) return false;
    agent.lastSignal = side;
    agent.lastSymbol = symbol;
    this.trades.push(trade);
    if (this.trades.length > MAX_TRADES) {
      this.trades.splice(0, this.trades.length - MAX_TRADES);
    }
    void this.persistTrade(trade).catch((error) => {
      console.error("failed to persist trade", error);
    });
    return true;
  }

  protected view(agent: AgentRuntime): AgentView {
    const positions = this.positionsOf(agent);
    const equity = roundUsd(agent.usdt + positions.reduce((sum, pos) => sum + pos.value, 0));
    const pnl = roundUsd(equity - agent.startingUsdt);
    const netPnl = roundUsd(positions.reduce((sum, pos) => sum + pos.netPnl, 0));
    const netCost = positions.reduce((sum, pos) => sum + pos.cost, 0);
    const netPct = netCost > 0 ? (netPnl / netCost) * 100 : 0;
    const priced = positions.length > 0 && positions.every((pos) => pos.exitPrice > 0);
    const netTone =
      !priced || Math.abs(netPnl) < 0.03 || Math.abs(netPct) < 0.25
        ? "even"
        : netPnl > 0
          ? "profit"
          : "loss";
    return {
      id: agent.id,
      strategy: agent.strategy,
      startingUsdt: agent.startingUsdt,
      allocPct: agent.allocPct,
      usdt: agent.usdt,
      holdings: agent.holdings,
      positions,
      positionCount: positions.length,
      equity,
      pnl,
      pnlPct: agent.startingUsdt === 0 ? 0 : (pnl / agent.startingUsdt) * 100,
      netPnl,
      netPct,
      netTone,
      tradeCount: this.trades.filter((t) => t.agentId === agent.id).length,
      lastSignal: agent.lastSignal,
      lastSymbol: agent.lastSymbol,
      lastError: agent.lastError,
      thought: this.publicThought(agent.id),
      status: agent.status ?? "active",
      bornAt: agent.bornAt,
      sharpe: sharpeRatio(this.equity[agent.id] ?? [], periodsFrom(this.agentInterval(agent))),
      vsBtc: (agent.startingUsdt === 0 ? 0 : (pnl / agent.startingUsdt) * 100) - this.btcReturnSince(agent),
      interval: this.agentInterval(agent),
    };
  }

  protected tickLeague() {
    const now = Date.now();
    if (now - this.lastLeagueTs < 6 * 60 * 60_000) return;
    this.lastLeagueTs = now;
    const week = 7 * 24 * 60 * 60_000;
    let changed = false;

    for (const agent of this.agents) {
      if (!agent.btcAtBirth) {
        const price = this.btcPrice();
        if (price) {
          agent.btcAtBirth = price;
          changed = true;
        }
      }
      if (agent.status === "killed" || now - (agent.bornAt || now) < week) continue;
      const row = this.view(agent);
      if (row.pnlPct < this.btcReturnSince(agent) && row.sharpe < 0) {
        agent.status = "killed";
        this.note(agent.id, {
          action: "skip",
          reason: `${agent.id}: killed. 7 hari kalah BTC dan Sharpe ${row.sharpe.toFixed(2)} < 0. Tidak dihapus.`,
        });
        changed = true;
      }
    }

    const live = this.agents.filter(
      (agent) => agent.status !== "killed" && now - (agent.bornAt || now) > 24 * 60 * 60_000,
    );
    if (live.length >= 2) {
      const ranked = [...live].sort((a, b) => this.view(b).pnlPct - this.view(a).pnlPct);
      for (const agent of live) agent.allocPct = agent.baseAlloc || agent.allocPct;
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      best.allocPct = Math.min(0.4, (best.baseAlloc || best.allocPct) * 1.5);
      worst.allocPct = Math.max(0.05, (worst.baseAlloc || worst.allocPct) * 0.5);
      this.note(best.id, {
        action: "wait",
        reason: `${best.id}: pemenang liga, alokasi naik ke ${(best.allocPct * 100).toFixed(0)}%.`,
      });
      changed = true;
    }

    if (changed) void this.persist();
  }

  private btcPrice() {
    const quote = this.quotes.BTCUSDT;
    return midPrice(quote?.bid, quote?.ask) || this.lastClose("BTCUSDT");
  }

  private btcReturnSince(agent: AgentRuntime) {
    const now = this.btcPrice();
    if (!agent.btcAtBirth || !now) return 0;
    return (now / agent.btcAtBirth - 1) * 100;
  }

  protected btcReturnPct() {
    const ref = this.agents.find((agent) => agent.btcAtBirth > 0);
    return ref ? this.btcReturnSince(ref) : 0;
  }

  private cashIfSold(agent: AgentView) {
    let proceeds = 0;
    for (const pos of agent.positions) {
      const bid = this.quotes[pos.symbol]?.bid ?? 0;
      if (!(bid > 0) || !(pos.qty > 0)) return { ready: false, pnl: 0, pct: 0 };
      const notional = pos.qty * bid;
      proceeds += notional * (1 - takerFee(this.fees, pos.symbol) - PPH22_FOREIGN_SELL);
    }
    const end = roundUsd(agent.usdt + proceeds);
    const pnl = roundUsd(end - agent.startingUsdt);
    const pct = agent.startingUsdt === 0 ? 0 : (pnl / agent.startingUsdt) * 100;
    return { ready: true, pnl, pct };
  }

  private leagueRows(agents: AgentView[], _btcReturnPct: number): LeagueRow[] {
    return agents
      .map((agent) => {
        const sold = this.cashIfSold(agent);
        return {
          id: agent.id,
          strategy: agent.strategy,
          status: agent.status,
          equity: agent.equity,
          pnlPct: agent.pnlPct,
          sharpe: agent.sharpe,
          vsBtc: agent.vsBtc,
          allocPct: agent.allocPct,
          rank: 0,
          interval: agent.interval,
          soldPnl: sold.pnl,
          soldPct: sold.pct,
          soldReady: sold.ready,
          positionCount: agent.positionCount,
        };
      })
      .sort((a, b) => {
        if (a.soldReady !== b.soldReady) return a.soldReady ? -1 : 1;
        return b.soldPnl - a.soldPnl;
      })
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  protected ensureThought(id: string): AgentThought {
    const current = this.thoughts.get(id);
    if (current) return current;
    const created: AgentThought = {
      status: this.feed.warmupDone < this.feed.warmupTotal ? "warming" : "waiting",
      summary: "Belum ada scan.",
      lastScanAt: null,
      scanned: 0,
      buySignals: 0,
      sellSignals: 0,
      nextCandleAt: this.nextCandleAt(this.config?.interval ?? "5m"),
      notes: [],
      topBuys: [],
    };
    this.thoughts.set(id, created);
    return created;
  }

  protected publicThought(id: string): AgentThought {
    const thought = this.ensureThought(id);
    if ((this.starting || this.feed.warmupDone < this.feed.warmupTotal) && thought.lastScanAt == null) {
      thought.status = "warming";
      thought.summary = `Warmup klines ${this.feed.warmupDone}/${this.feed.warmupTotal}. Belum memutuskan coin.`;
    } else if (thought.lastScanAt && Date.now() - thought.lastScanAt < 1500) {
      thought.status = "scanning";
    }
    return thought;
  }

  protected note(id: string, thought: Omit<Thought, "ts">) {
    const state = this.ensureThought(id);
    state.notes.unshift({ ...thought, ts: Date.now() });
    if (state.notes.length > 40) state.notes.length = 40;
    state.summary = thought.reason;
  }

  protected summarize(id: string, interval: string) {
    const thought = this.ensureThought(id);
    const top = thought.topBuys[0];
    if (top) {
      return `Watchlist ${thought.buySignals} pair, teratas ${top.symbol}. Entry hanya jika lolos filter; cash boleh menganggur.`;
    }
    return `Scan ${thought.scanned} pair, belum ada setup layak. Hold cash sampai ${interval} ${fmtClock(thought.nextCandleAt)}.`;
  }

  private maybeBackfillScan() {
    if (!this.running || this.starting) return;
    if (this.feed.warmupDone < this.feed.warmupTotal || this.universe.length === 0) return;
    let budget = 40;
    for (const agent of this.agents) {
      if (budget <= 0) break;
      if (agent.status === "killed") continue;
      const thought = this.thoughts.get(agent.id);
      if (!thought || thought.lastScanAt == null) {
        void this.scanOne(agent, this.universeFor(agent));
        budget -= 1;
      }
    }
  }

  private nextCandleAt(interval = "5m") {
    const ms = intervalMs(interval);
    const sample = Object.values(this.series(interval))
      .map((series) => series.at(-1)?.openTime)
      .find((value) => value != null);
    if (!sample) return Date.now() + ms;
    return sample + ms;
  }

  protected positionsOf(agent: AgentRuntime, trades = this.trades): PositionView[] {
    const agentTrades = trades.filter((trade) => trade.agentId === agent.id);
    return Object.entries(agent.holdings)
      .filter(([, qty]) => qty > 0)
      .map(([asset, qty]) => {
        const symbol = toSymbol(asset);
        const quote = this.quotes[symbol];
        const mark = midPrice(quote?.bid, quote?.ask) || this.lastClose(symbol);
        const exitPrice = quote?.bid || 0;
        const sellFee = takerFee(this.fees, symbol);
        const lot = openLot(agentTrades, symbol, qty);
        const cost = lot.cost > 0 ? lot.cost : qty * (quote?.ask || mark);
        const entryPrice = lot.entryPrice > 0 ? lot.entryPrice : cost / qty;
        const ready = exitPrice > 0 && cost > 0;
        const proceeds = ready ? qty * exitPrice * (1 - sellFee - PPH22_FOREIGN_SELL) : 0;
        const netPnl = ready ? roundUsd(proceeds - cost) : 0;
        const netPct = ready && cost > 0 ? (netPnl / cost) * 100 : 0;
        const even = !ready || Math.abs(netPnl) < 0.03 || Math.abs(netPct) < 0.25;
        const tone: PositionTone = even ? "even" : netPnl > 0 ? "profit" : "loss";
        return {
          symbol,
          asset,
          qty,
          mark,
          value: roundUsd(qty * mark),
          cost: roundUsd(cost),
          entryPrice,
          boughtAt: lot.boughtAt,
          exitPrice,
          netPnl,
          netPct,
          tone,
        };
      })
      .sort((a, b) => b.netPnl - a.netPnl);
  }

  protected markEquity(agent: AgentRuntime) {
    return agent.usdt + this.positionsOf(agent).reduce((sum, pos) => sum + pos.value, 0);
  }

  protected quotesFor(agents: AgentView[]) {
    const needed = new Set<string>();
    for (const agent of agents) {
      for (const pos of agent.positions) needed.add(pos.symbol);
    }
    const quotes: Record<string, BookTicker> = {};
    for (const symbol of needed) {
      if (this.quotes[symbol]) quotes[symbol] = this.quotes[symbol];
    }
    return quotes;
  }

  private recordEquity(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEquityTs < 60_000) return;
    this.lastEquityTs = now;
    for (const agent of this.agents) {
      const view = this.view(agent);
      const series = this.equity[agent.id] ?? [];
      series.push({ ts: now, equity: view.equity });
      if (series.length > MAX_EQUITY) series.splice(0, series.length - MAX_EQUITY);
      this.equity[agent.id] = series;
    }
  }

  protected persist() {
    if (this.persisting || this.agents.length === 0) return Promise.resolve();
    this.persisting = true;
    const equity: Record<string, EquityPoint[]> = {};
    const marks: [string, number][] = [];
    for (const [id, series] of Object.entries(this.equity)) {
      const since = this.equityMark.get(id) ?? 0;
      const fresh = series.filter((point) => point.ts > since);
      if (fresh.length === 0) continue;
      equity[id] = fresh;
      marks.push([id, fresh[fresh.length - 1].ts]);
    }
    return this.saveDeskState({
      startedAt: this.startedAt,
      agents: this.agents,
      trades: this.trades,
      equity,
    })
      .then(() => {
        for (const [id, ts] of marks) this.equityMark.set(id, ts);
      })
      .catch((error) => {
        console.error("failed to persist desk state", error);
      })
      .finally(() => {
        this.persisting = false;
      });
  }

  private rememberEquityMarks() {
    for (const [id, series] of Object.entries(this.equity)) {
      const ts = series.at(-1)?.ts;
      if (ts) this.equityMark.set(id, ts);
    }
  }
}

function emptyFeed(): FeedStatus {
  return {
    connected: false,
    host: "",
    universe: 0,
    warmupDone: 0,
    warmupTotal: 0,
  };
}

function openLot(trades: Trade[], symbol: string, qty: number) {
  const lots: { qty: number; cost: number; ts: number }[] = [];
  for (const trade of trades.filter((row) => row.symbol === symbol).sort((a, b) => a.ts - b.ts)) {
    if (trade.side === "BUY") {
      lots.push({ qty: trade.qty, cost: trade.qty * trade.price + trade.fee, ts: trade.ts });
      continue;
    }
    let left = trade.qty;
    while (left > 1e-12 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(left, lot.qty);
      const frac = lot.qty > 0 ? take / lot.qty : 1;
      lot.cost *= 1 - frac;
      lot.qty -= take;
      left -= take;
      if (lot.qty <= 1e-10) lots.shift();
    }
  }
  const held = lots.reduce((sum, lot) => sum + lot.qty, 0);
  const costAll = lots.reduce((sum, lot) => sum + lot.cost, 0);
  if (held <= 0) return { cost: 0, entryPrice: 0, boughtAt: null as number | null };
  const cost = (costAll / held) * qty;
  return { cost, entryPrice: cost / qty, boughtAt: lots[0]?.ts ?? null };
}

function intervalMs(interval: string) {
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (!match) return 5 * 60_000;
  const n = Number(match[1]);
  if (match[2] === "s") return n * 1000;
  if (match[2] === "h") return n * 60 * 60_000;
  if (match[2] === "d") return n * 24 * 60 * 60_000;
  return n * 60_000;
}

function fmtClock(ts: number | null) {
  if (!ts) return "sebentar lagi";
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function periodsFrom(interval?: string) {
  if (interval === "1s") return 365 * 24 * 60 * 60;
  if (interval === "1m") return 365 * 24 * 60;
  if (interval === "3m") return 365 * 24 * 20;
  if (interval === "15m") return 365 * 24 * 4;
  if (interval === "1h") return 24 * 365;
  if (interval === "4h") return 6 * 365;
  return 12 * 24 * 365;
}

/** Positions large enough to trade. Dust below $1 does not consume a slot. */
export function materialPositions(agent: AgentRuntime, priceOf: (symbol: string) => number) {
  let count = 0;
  for (const [asset, qty] of Object.entries(agent.holdings)) {
    if (!(qty > 0)) continue;
    const price = priceOf(toSymbol(asset));
    if (price > 0 && price * qty >= 1) count += 1;
  }
  return count;
}

function riskLimits(agent: AgentRuntime) {
  let defaults: Record<string, number> = {};
  try {
    defaults = getStrategy(agent.strategy).defaults;
  } catch {
    defaults = {};
  }
  const params = { ...defaults, ...agent.params };
  return {
    minScore: params.minScore ?? 0,
    atrPeriod: params.atrPeriod ?? 14,
    chanLookback: params.chanLookback ?? 22,
    atrMult: params.atrMult ?? 2.5,
  };
}

function clampAlloc(value: number) {
  if (!Number.isFinite(value)) return 0.2;
  return Math.min(1, Math.max(0.01, value));
}

export function getPaperEngine(): PaperEngine {
  const globalForEngine = globalThis as typeof globalThis & {
    __paperEngine?: PaperEngine;
  };
  if (!globalForEngine.__paperEngine) {
    globalForEngine.__paperEngine = new PaperEngine();
  }
  return globalForEngine.__paperEngine;
}

