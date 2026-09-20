import { PaperEngine, getPaperEngine } from "./engine";
import { LIVE_AGENT_SPECS, liveBudgetUsdt, liveKeysConfigured } from "./desk";
import { fetchSpotUsdtFree } from "./live/binance";
import { executeLiveMarket } from "./live/broker";
import { getStrategy } from "./strategies/index";
import { takerFee } from "./market/fees";
import { isPegged } from "./config";
import { roundUsd } from "./paper/math";
import {
  deleteLiveAgent,
  insertLiveAgent,
  insertLiveTrade,
  loadLiveAgentTrades,
  loadLiveState,
  resetLivePortfolios,
  saveLiveState,
} from "./storage/live-store";
import type { AgentRuntime, AppConfig, CreateAgentInput, Snapshot, Trade } from "./types";

export class LiveEngine extends PaperEngine {
  spotUsdt = 0;
  budgetUsdt = 0;
  private fillLock: Promise<void> = Promise.resolve();

  snapshot(): Snapshot {
    const agents = this.agents.map((agent) => this.view(agent));
    const equity: Snapshot["equity"] = {};
    for (const agent of this.agents) equity[agent.id] = (this.equity[agent.id] ?? []).slice(-80);
    return {
      mode: "live",
      running: this.running,
      starting: this.starting,
      startedAt: this.startedAt,
      interval: this.config?.interval ?? LIVE_AGENT_SPECS[0].interval,
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
      },
    };
  }

  protected loadDeskConfig(): AppConfig {
    return {
      mode: "live",
      interval: LIVE_AGENT_SPECS[0].interval,
      onSignal: "candle_close",
      feeRate: 0.001,
    };
  }

  protected async beforeStart() {
    if (!liveKeysConfigured()) {
      throw new Error("Set BINANCE_API_KEY_REAL dan BINANCE_API_SECRET_REAL dulu sebelum Start Live.");
    }
    this.spotUsdt = await fetchSpotUsdtFree();
    this.budgetUsdt = roundUsd(Math.min(this.spotUsdt, liveBudgetUsdt()));
    const perAgent = this.budgetUsdt / LIVE_AGENT_SPECS.length;
    if (perAgent < 5) {
      throw new Error(
        `Budget per agent $${perAgent.toFixed(2)} < min notional $5. Spot USDT ${this.spotUsdt.toFixed(2)}, butuh ≥ $${(
          5 * LIVE_AGENT_SPECS.length
        ).toFixed(0)}.`,
      );
    }
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

  protected async ensureSamples() {
    const sleeve = this.sleeveUsdt();
    const wanted = new Set(LIVE_AGENT_SPECS.map((spec) => spec.id));
    const next: AgentRuntime[] = [];

    for (const spec of LIVE_AGENT_SPECS) {
      const strategy = getStrategy(spec.strategy);
      const existing = this.agents.find((agent) => agent.id === spec.id);
      if (existing) {
        const flat =
          Object.keys(existing.holdings).length === 0 && existing.usdt >= existing.startingUsdt - 0.05;
        // Always keep live params in sync with roster (e.g. drop liquid-only universe).
        existing.params = { ...strategy.defaults, ...spec.params };
        delete existing.params.liquid;
        existing.allocPct = spec.allocPct;
        existing.baseAlloc = spec.allocPct;
        existing.interval = spec.interval;
        if (flat && Math.abs(existing.startingUsdt - sleeve) > 0.05) {
          existing.startingUsdt = sleeve;
          existing.usdt = sleeve;
        }
        await this.persistAgent(existing);
        next.push(existing);
        continue;
      }
      const agent: AgentRuntime = {
        id: spec.id,
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

    // Drop any live agent no longer in the roster (Spot wallet is shared; mirror is advisory).
    for (const agent of this.agents) {
      if (wanted.has(agent.id)) continue;
      await this.deletePersistedAgent(agent.id);
      delete this.equity[agent.id];
      this.thoughts.delete(agent.id);
    }

    this.agents = next;
  }

  protected tickLeague() {
    // Live desk: no tournament kill.
  }

  async createAgent(_input: CreateAgentInput): Promise<never> {
    throw new Error(`Live desk menjalankan ${LIVE_AGENT_SPECS.length} agent tetap.`);
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
      this.trades.push(trade);
      if (this.trades.length > 400) this.trades.splice(0, this.trades.length - 400);
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
      this.note(agent.id, {
        action: "skip",
        symbol,
        reason: `Live order gagal: ${agent.lastError}`,
      });
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
