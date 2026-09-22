import { PaperEngine, getPaperEngine, materialPositions } from "./engine";
import {
  LIVE_AGENT_SPECS,
  LIVE_ENSEMBLE_MS,
  LIVE_RISK_PARAMS,
  liveBudgetUsdt,
  liveKeysConfigured,
  type LiveAgentSpec,
} from "./desk";
import { pickChampion, scorePaperAgent, type ChampionPick } from "./ensemble";
import { fetchSpotUsdtFree } from "./live/binance";
import { executeLiveMarket } from "./live/broker";
import { getStrategy } from "./strategies/index";
import { takerFee } from "./market/fees";
import { isPegged } from "./config";
import { midPrice, roundUsd } from "./paper/math";
import { countTradesByAgent } from "./storage/store";
import {
  deleteLiveAgent,
  getLiveMeta,
  insertLiveAgent,
  insertLiveTrade,
  loadLiveAgentTrades,
  loadLiveState,
  resetLivePortfolios,
  saveLiveState,
  setLiveMeta,
} from "./storage/live-store";
import type { AgentRuntime, AppConfig, CreateAgentInput, Snapshot, Trade } from "./types";

const CHAMPION_META_KEY = "champion";

export class LiveEngine extends PaperEngine {
  spotUsdt = 0;
  budgetUsdt = 0;
  champion: ChampionPick | null = null;
  private fillLock: Promise<void> = Promise.resolve();
  private lastEnsembleTs = 0;

  snapshot(): Snapshot {
    const agents = this.agents.map((agent) => this.view(agent));
    const equity: Snapshot["equity"] = {};
    for (const agent of this.agents) equity[agent.id] = (this.equity[agent.id] ?? []).slice(-80);
    const active = this.activeSpec();
    return {
      mode: "live",
      running: this.running,
      starting: this.starting,
      startedAt: this.startedAt,
      interval: active.interval,
      feeRate: this.fees.defaultTaker,
      feeLabel: this.fees.label,
      feed: this.feed,
      quotes: this.quotesFor(agents),
      agents,
      trades: this.trades.slice(-80).reverse(),
      equity,
      btcReturnPct: this.btcReturnPct(),
      regime: this.currentRegime(),
      league: [],
      live: {
        keysConfigured: liveKeysConfigured(),
        spotUsdt: this.spotUsdt,
        budgetUsdt: this.budgetUsdt,
        agentId: LIVE_AGENT_SPECS.map((spec) => spec.id).join(","),
        champion: this.champion
          ? {
              paperId: this.champion.paperId,
              strategy: this.champion.strategy,
              interval: this.champion.interval,
              score: this.champion.score,
              recentPct: this.champion.recentPct,
            }
          : null,
      },
    };
  }

  protected loadDeskConfig(): AppConfig {
    const active = this.activeSpec();
    return {
      mode: "live",
      interval: active.interval,
      onSignal: "candle_close",
      feeRate: 0.001,
    };
  }

  protected async beforeStart() {
    if (!liveKeysConfigured()) {
      throw new Error("Set BINANCE_API_KEY_REAL dan BINANCE_API_SECRET_REAL dulu sebelum Start Live.");
    }
    this.spotUsdt = await fetchSpotUsdtFree();
    // Sleeve for brand-new agents only; existing mirrors keep DB startingUsdt/holdings.
    this.budgetUsdt = roundUsd(Math.min(Math.max(this.spotUsdt, 5), liveBudgetUsdt()));
    await this.restoreChampion();
  }

  protected async resetDeskPortfolios() {
    await resetLivePortfolios();
  }

  protected async loadDeskState() {
    return loadLiveState();
  }

  protected async saveDeskState(state: Parameters<typeof saveLiveState>[0]) {
    await saveLiveState(state);
  }

  protected async loadTradesFor(id: string) {
    return loadLiveAgentTrades(id);
  }

  protected async persistAgent(agent: AgentRuntime) {
    await insertLiveAgent(agent);
  }

  protected async deletePersistedAgent(id: string) {
    await deleteLiveAgent(id);
  }

  protected async persistAgents(agents: AgentRuntime[]) {
    for (const agent of agents) await insertLiveAgent(agent);
  }

  protected async persistTrade(trade: Trade) {
    await insertLiveTrade(trade);
  }

  protected defaultAgents(): AgentRuntime[] {
    return [];
  }

  private sleeveUsdt() {
    return roundUsd(this.budgetUsdt / LIVE_AGENT_SPECS.length);
  }

  private activeSpec(): LiveAgentSpec {
    const base = LIVE_AGENT_SPECS[0];
    if (!this.champion) return base;
    return {
      id: base.id,
      strategy: this.champion.strategy,
      interval: this.champion.interval,
      allocPct: base.allocPct,
      params: {
        ...this.champion.params,
        ...LIVE_RISK_PARAMS,
      },
    };
  }

  private markOf = (symbol: string) => {
    const quote = this.quotes[symbol];
    return midPrice(quote?.bid, quote?.ask) || this.lastClose(symbol);
  };

  private isFlat(agent: AgentRuntime) {
    return materialPositions(agent, this.markOf) === 0;
  }

  private async restoreChampion() {
    try {
      const raw = await getLiveMeta(CHAMPION_META_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ChampionPick;
      if (!parsed?.paperId || !parsed?.strategy) return;
      this.champion = {
        paperId: parsed.paperId,
        strategy: parsed.strategy,
        interval: parsed.interval || "5m",
        params: parsed.params && typeof parsed.params === "object" ? parsed.params : {},
        score: Number(parsed.score) || 0,
        recentPct: Number(parsed.recentPct) || 0,
        pnlPct: Number(parsed.pnlPct) || 0,
        sharpe: Number(parsed.sharpe) || 0,
        tradeCount: Number(parsed.tradeCount) || 0,
      };
    } catch (error) {
      console.error("failed to restore live champion", error);
    }
  }

  private async persistChampion(winner: ChampionPick | null) {
    try {
      if (!winner) {
        await setLiveMeta(CHAMPION_META_KEY, "");
        return;
      }
      await setLiveMeta(CHAMPION_META_KEY, JSON.stringify(winner));
    } catch (error) {
      console.error("failed to persist live champion", error);
    }
  }

  protected async ensureSamples() {
    const sleeve = this.sleeveUsdt();
    const wanted = new Set(LIVE_AGENT_SPECS.map((spec) => spec.id));
    const next: AgentRuntime[] = [];
    const spec = this.activeSpec();
    const strategy = getStrategy(spec.strategy);

    for (const roster of LIVE_AGENT_SPECS) {
      const existing = this.agents.find((agent) => agent.id === roster.id);
      if (existing) {
        existing.strategy = strategy.name;
        existing.params = { ...strategy.defaults, ...spec.params };
        existing.allocPct = spec.allocPct;
        existing.baseAlloc = spec.allocPct;
        existing.interval = spec.interval;
        if (this.isFlat(existing) && existing.usdt >= existing.startingUsdt - 0.05) {
          if (Math.abs(existing.startingUsdt - sleeve) > 0.05 && this.spotUsdt >= sleeve) {
            existing.startingUsdt = sleeve;
            existing.usdt = sleeve;
          }
        }
        await this.persistAgent(existing);
        next.push(existing);
        continue;
      }
      const agent: AgentRuntime = {
        id: roster.id,
        strategy: strategy.name,
        startingUsdt: sleeve,
        allocPct: spec.allocPct,
        baseAlloc: spec.allocPct,
        params: { ...strategy.defaults, ...spec.params },
        usdt: sleeve,
        holdings: {},
        lastSignal: "HOLD",
        status: "active",
        bornAt: Date.now(),
        btcAtBirth: 0,
        interval: spec.interval,
      };
      next.push(agent);
      this.equity[agent.id] ??= [];
      await this.persistAgent(agent);
    }

    for (const agent of this.agents) {
      if (wanted.has(agent.id)) continue;
      await this.deletePersistedAgent(agent.id);
      delete this.equity[agent.id];
      this.thoughts.delete(agent.id);
    }

    this.agents = next;
    if (this.config) this.config.interval = spec.interval;
  }

  protected tickLeague() {
    const now = Date.now();
    if (this.champion && now - this.lastEnsembleTs < LIVE_ENSEMBLE_MS) return;
    this.lastEnsembleTs = now;
    void this.syncChampionFromPaper().catch((error) => {
      console.error("live ensemble sync failed", error);
    });
  }

  private async syncChampionFromPaper() {
    const paper = getPaperEngine();
    if (!paper.running && !paper.starting) {
      void paper.start().catch((error) => console.error("paper autostart for ensemble failed", error));
      return;
    }
    if (paper.starting || paper.agents.length === 0) return;

    const snap = paper.snapshot();
    const tradeCounts = await countTradesByAgent();
    const ranked: ChampionPick[] = [];
    for (const row of snap.agents) {
      const runtime = paper.agents.find((agent) => agent.id === row.id);
      if (!runtime) continue;
      const pick = scorePaperAgent({
        agent: runtime,
        equity: snap.equity[row.id] ?? [],
        tradeCount: tradeCounts[row.id] ?? 0,
        sharpe: row.sharpe,
        pnlPct: row.pnlPct,
      });
      if (pick) ranked.push(pick);
    }

    const winner = pickChampion(ranked);
    if (!winner) {
      this.note(LIVE_AGENT_SPECS[0].id, {
        action: "wait",
        reason: "Ensemble: belum ada juara paper 24 jam positif. Live tetap di fallback + risk guard.",
      });
      return;
    }

    const changed =
      !this.champion ||
      this.champion.paperId !== winner.paperId ||
      this.champion.strategy !== winner.strategy ||
      this.champion.interval !== winner.interval;

    // Always remember the winner; only defer strategy mutation when non-flat.
    this.champion = winner;
    await this.persistChampion(winner);

    const live = this.agents[0];
    if (!live) return;

    if (!changed) {
      this.note(live.id, {
        action: "wait",
        reason: `Ensemble: juara tetap ${winner.paperId} (24h ${winner.recentPct.toFixed(2)}%, score ${winner.score.toFixed(2)}).`,
      });
      return;
    }

    if (!this.isFlat(live)) {
      this.note(live.id, {
        action: "wait",
        reason: `Ensemble: juara baru ${winner.paperId}, tapi masih ada posisi. Ganti strategi setelah flat.`,
      });
      return;
    }

    const strategy = getStrategy(winner.strategy);
    live.strategy = strategy.name;
    live.interval = winner.interval;
    live.params = { ...strategy.defaults, ...winner.params, ...LIVE_RISK_PARAMS };
    live.allocPct = LIVE_AGENT_SPECS[0].allocPct;
    live.baseAlloc = live.allocPct;
    if (this.config) this.config.interval = winner.interval;
    await this.persistAgent(live);
    this.note(live.id, {
      action: "wait",
      reason: `Ensemble: live mengikuti ${winner.paperId} · ${winner.strategy} · ${winner.interval} · 24h ${winner.recentPct.toFixed(2)}%. Risk: full sleeve · TP nett +1.5% / SL nett -1.2% / no-chase.`,
    });
    void this.persist();
  }

  async createAgent(_input: CreateAgentInput): Promise<never> {
    throw new Error(`Live desk menjalankan ${LIVE_AGENT_SPECS.length} agent ensemble.`);
  }

  async removeAgent(_id: string): Promise<never> {
    throw new Error("Agent Live tidak boleh dihapus dari UI. Stop desk saja.");
  }

  protected async fill(agent: AgentRuntime, symbol: string, side: "BUY" | "SELL", sizePct: number) {
    if (!this.config) return false;
    if (side === "BUY" && isPegged(symbol)) return false;

    const run = this.fillLock.then(() => this.fillUnlocked(agent, symbol, side, sizePct));
    this.fillLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fillUnlocked(
    agent: AgentRuntime,
    symbol: string,
    side: "BUY" | "SELL",
    sizePct: number,
  ) {
    try {
      if (side === "BUY") {
        const realFree = await fetchSpotUsdtFree();
        this.spotUsdt = realFree;
        const want = agent.usdt * sizePct;
        if (want > realFree + 1e-9) {
          const capped = realFree / agent.usdt;
          if (!(capped > 0) || realFree < 5) {
            this.note(agent.id, {
              action: "wait",
              symbol,
              reason: `Spot USDT real ${realFree.toFixed(2)} tidak cukup untuk sleeve agent (butuh ~${want.toFixed(2)}).`,
            });
            return false;
          }
          sizePct = Math.min(sizePct, capped);
        }
      }

      const trade = await executeLiveMarket({
        agentId: agent.id,
        symbol,
        side,
        feeRate: takerFee(this.fees, symbol),
        portfolio: agent,
        sizePct,
      });
      if (!trade) return false;
      agent.lastSignal = side;
      agent.lastSymbol = symbol;
      agent.lastError = undefined;
      this.recordTrade(trade);
      void this.persistTrade(trade).catch((error) => {
        console.error("failed to persist live trade", error);
      });
      void fetchSpotUsdtFree()
        .then((usdt) => {
          this.spotUsdt = usdt;
        })
        .catch(() => undefined);
      return true;
    } catch (error) {
      agent.lastError = error instanceof Error ? error.message : String(error);
      // Dust leftovers that fail Binance LOT_SIZE are noise — keep trying silently off the thought feed.
      if (!agent.lastError.includes("LOT_SIZE")) {
        this.note(agent.id, {
          action: "skip",
          symbol,
          reason: `Live order gagal: ${agent.lastError}`,
        });
      }
      return false;
    }
  }
}

export function getLiveEngine(): LiveEngine {
  const globalForEngine = globalThis as typeof globalThis & {
    __liveEngine?: LiveEngine;
  };
  if (!globalForEngine.__liveEngine) {
    globalForEngine.__liveEngine = new LiveEngine();
  }
  return globalForEngine.__liveEngine;
}

export { getPaperEngine };
