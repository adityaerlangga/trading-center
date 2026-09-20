import type { BookTicker, Candle, FeedStatus } from "../types";
import { WS_HOSTS } from "./hosts";

type Handlers = {
  onQuote: (quote: BookTicker) => void;
  onKline: (symbol: string, interval: string, candle: Candle) => void;
  onStatus: (status: FeedStatus) => void;
};

export type KlineSub = { symbol: string; interval: string };

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private hostIndex = 0;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private subId = 1;
  private lastRx = 0;
  private watchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly subs: KlineSub[],
    private readonly handlers: Handlers,
  ) {}

  start() {
    this.closedByUs = false;
    this.lastRx = Date.now();
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.watch(), 15_000);
    this.connect();
  }

  stop() {
    this.closedByUs = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.subscribeTimer) clearTimeout(this.subscribeTimer);
    this.reconnectTimer = null;
    this.subscribeTimer = null;
    this.ws?.close();
    this.ws = null;
    this.handlers.onStatus({
      connected: false,
      host: this.host(),
      universe: this.subs.length,
      warmupDone: 0,
      warmupTotal: this.subs.length,
    });
  }

  private host() {
    return WS_HOSTS[this.hostIndex % WS_HOSTS.length];
  }

  private watch() {
    if (this.closedByUs || !this.ws) return;
    if (Date.now() - this.lastRx < 60_000) return;
    this.ws.close();
  }

  private connect() {
    this.lastRx = Date.now();
    const host = this.host();
    this.handlers.onStatus({
      connected: false,
      host,
      universe: this.subs.length,
      warmupDone: 0,
      warmupTotal: this.subs.length,
    });

    const ws = new WebSocket(`${host}/ws`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoffMs = 1000;
      this.handlers.onStatus({
        connected: true,
        host,
        universe: this.subs.length,
        warmupDone: 0,
        warmupTotal: this.subs.length,
      });
      this.subscribeAll(ws);
    });

    ws.addEventListener("message", (event) => {
      this.handleMessage(String(event.data));
    });

    ws.addEventListener("error", () => {
      this.handlers.onStatus({
        connected: false,
        host,
        error: "WebSocket error",
        universe: this.subs.length,
        warmupDone: 0,
        warmupTotal: this.subs.length,
      });
    });

    ws.addEventListener("close", () => {
      this.handlers.onStatus({
        connected: false,
        host,
        universe: this.subs.length,
        warmupDone: 0,
        warmupTotal: this.subs.length,
      });
      if (!this.closedByUs) this.scheduleReconnect();
    });
  }

  private subscribeAll(ws: WebSocket) {
    const streams = [
      "!bookTicker",
      ...this.subs.map((sub) => `${sub.symbol.toLowerCase()}@kline_${sub.interval}`),
    ];
    const batches: string[][] = [];
    for (let i = 0; i < streams.length; i += 40) {
      batches.push(streams.slice(i, i + 40));
    }

    const sendBatch = (index: number) => {
      if (this.closedByUs || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const params = batches[index];
      if (!params) return;
      ws.send(
        JSON.stringify({
          method: "SUBSCRIBE",
          params,
          id: this.subId++,
        }),
      );
      if (index + 1 < batches.length) {
        this.subscribeTimer = setTimeout(() => sendBatch(index + 1), 250);
      }
    };
    sendBatch(0);
  }

  private scheduleReconnect() {
    this.hostIndex += 1;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  private handleMessage(raw: string) {
    this.lastRx = Date.now();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.result === null || parsed.id != null && parsed.result !== undefined) {
      return;
    }

    const payload = (parsed.data as Record<string, unknown> | undefined) ?? parsed;
    const stream = String(parsed.stream ?? parsed.e ?? "");

    if (
      stream.endsWith("@bookTicker") ||
      stream === "!bookTicker" ||
      (payload.b != null && payload.a != null && payload.s != null && payload.e == null)
    ) {
      this.handlers.onQuote({
        symbol: String(payload.s),
        bid: Number(payload.b),
        ask: Number(payload.a),
        ts: Date.now(),
      });
      return;
    }

    if (stream.includes("kline") || payload.e === "kline") {
      const k = payload.k as {
        t: number;
        T: number;
        s: string;
        i?: string;
        o: string;
        h: string;
        l: string;
        c: string;
        v: string;
        x: boolean;
      };
      if (!k) return;
      this.handlers.onKline(k.s, String(k.i ?? "5m"), {
        openTime: k.t,
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        closeTime: k.T,
        isClosed: k.x,
      });
    }
  }
}
