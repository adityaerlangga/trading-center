export type Mode = "paper" | "live";
export type Side = "BUY" | "SELL";
export type Signal = "HOLD" | "BUY" | "SELL";

export type AgentConfig = {
  id: string;
  strategy: string;
  startingUsdt: number;
  allocPct: number;
  params: Record<string, number>;
};

export type AppConfig = {
  mode: Mode;
  interval: string;
  onSignal: "candle_close";
  feeRate: number;
};

export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isClosed: boolean;
};

export type BookTicker = {
  symbol: string;
  bid: number;
  ask: number;
  ts: number;
};

export type Trade = {
  id: string;
  agentId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  feeRate?: number;
  ts: number;
};

export type EquityPoint = {
  ts: number;
  equity: number;
};

export type AgentStatus = "active" | "killed";

export type AgentRuntime = {
  id: string;
  strategy: string;
  startingUsdt: number;
  allocPct: number;
  baseAlloc: number;
  params: Record<string, number>;
  usdt: number;
  holdings: Record<string, number>;
  lastSignal: Signal;
  lastSymbol?: string;
  lastError?: string;
  status: AgentStatus;
  bornAt: number;
  btcAtBirth: number;
  interval: string;
};

export type PositionTone = "profit" | "loss" | "even";

export type PositionView = {
  symbol: string;
  asset: string;
  qty: number;
  mark: number;
  value: number;
  cost: number;
  entryPrice: number;
  boughtAt: number | null;
  exitPrice: number;
  netPnl: number;
  netPct: number;
  tone: PositionTone;
};

export type Thought = {
  ts: number;
  action: "scan" | "buy" | "sell" | "skip" | "wait";
  symbol?: string;
  reason: string;
  score?: number;
};

export type AgentThought = {
  status: "warming" | "scanning" | "waiting";
  summary: string;
  lastScanAt: number | null;
  scanned: number;
  buySignals: number;
  sellSignals: number;
  nextCandleAt: number | null;
  notes: Thought[];
  topBuys: { symbol: string; score: number; reason: string }[];
};

export type AgentView = {
  id: string;
  strategy: string;
  startingUsdt: number;
  allocPct: number;
  usdt: number;
  holdings: Record<string, number>;
  positions: PositionView[];
  positionCount: number;
  equity: number;
  pnl: number;
  pnlPct: number;
  netPnl: number;
  netPct: number;
  netTone: PositionTone;
  tradeCount: number;
  lastSignal: Signal;
  lastSymbol?: string;
  lastError?: string;
  thought: AgentThought;
  status: AgentStatus;
  bornAt: number;
  sharpe: number;
  vsBtc: number;
  interval: string;
};

export type FeedStatus = {
  connected: boolean;
  host: string;
  error?: string;
  universe: number;
  warmupDone: number;
  warmupTotal: number;
};

export type Snapshot = {
  mode: Mode;
  running: boolean;
  starting: boolean;
  startedAt: number | null;
  interval: string;
  feeRate: number;
  feeLabel: string;
  feed: FeedStatus;
  quotes: Record<string, BookTicker>;
  agents: AgentView[];
  trades: Trade[];
  equity: Record<string, EquityPoint[]>;
  league: LeagueRow[];
  btcReturnPct: number;
  regime: "trend" | "chop";
  live?: {
    keysConfigured: boolean;
    spotUsdt: number;
    budgetUsdt: number;
    agentId: string;
  };
};

export type LeagueRow = {
  id: string;
  strategy: string;
  status: AgentStatus;
  equity: number;
  pnlPct: number;
  sharpe: number;
  vsBtc: number;
  allocPct: number;
  rank: number;
  interval: string;
  /** Profit vs starting cash if every coin is sold at bid, after taker fee and PPh 22. */
  soldPnl: number;
  soldPct: number;
  soldReady: boolean;
  positionCount: number;
};

export type CreateAgentInput = {
  id?: string;
  name?: string;
  strategy: string;
  startingUsdt: number | string;
  allocPct?: number;
  params?: Record<string, number>;
  interval?: string;
};
