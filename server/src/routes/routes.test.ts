import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { Subject } from "rxjs";

const ibMock = vi.hoisted(() => ({
  isConnected: true,
  health: vi.fn(() => ({ connected: true, isDelayed: false })),
}));
vi.mock("../ib/connection.js", () => ({ ib: ibMock }));
vi.mock("../ib/pnlHistory.js", () => ({
  getPnlHistory: vi.fn(async () => ({ series: [] })),
  invalidatePnlCache: vi.fn(),
}));
vi.mock("../ib/flex.js", () => ({
  getFlexTrades: vi.fn(async () => []),
  tradesAsOf: vi.fn(async () => 123),
}));
vi.mock("../ib/activity.js", () => ({
  getActivity: vi.fn(async () => ({ symbols: [], tradesAsOf: 123 })),
}));
vi.mock("../ib/portfolio.js", () => ({
  getPortfolio: vi.fn(async () => ({ account: "U1", balances: {}, positions: [] })),
}));
vi.mock("../ib/contracts.js", () => ({
  searchSymbols: vi.fn(async () => [{ symbol: "AAPL" }]),
  getSymbolInfo: vi.fn(async () => ({ symbol: "AAPL" })),
  resolveContract: vi.fn((p: { conId?: number; symbol?: string }) => {
    if (!p.conId && !p.symbol) throw new Error("Either conId or symbol is required");
    return { conId: p.conId, symbol: p.symbol };
  }),
}));
vi.mock("../ib/marketData.js", () => ({
  getHistory: vi.fn(async () => [{ time: 1, close: 1 }]),
  streamQuote: vi.fn(),
}));

import { getPnlHistory, invalidatePnlCache } from "../ib/pnlHistory.js";
import { getFlexTrades } from "../ib/flex.js";
import { getSymbolInfo, searchSymbols } from "../ib/contracts.js";
import { getHistory, streamQuote, type Quote } from "../ib/marketData.js";
import { registerHealthRoutes } from "./health.js";
import { registerMarketRoutes } from "./market.js";
import { registerPnlRoutes } from "./pnl.js";
import { registerActivityRoutes } from "./activity.js";
import { registerPortfolioRoutes } from "./portfolio.js";
import { registerQuoteRoutes } from "./quotes.js";

let app: FastifyInstance;
const routes: { method: string; url: string }[] = [];

beforeEach(async () => {
  ibMock.isConnected = true;
  routes.length = 0;
  app = Fastify();
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) routes.push({ method: m, url: r.url });
  });
  await app.register(websocket);
  await app.register(registerHealthRoutes);
  await app.register(registerMarketRoutes);
  await app.register(registerQuoteRoutes);
  await app.register(registerPortfolioRoutes);
  await app.register(registerPnlRoutes);
  await app.register(registerActivityRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});

describe("read-only guardrail", () => {
  it("exposes no mutating routes besides the Flex refresh", () => {
    const mutating = routes.filter((r) => !["GET", "HEAD"].includes(r.method));
    expect(mutating).toEqual([{ method: "POST", url: "/api/pnl/refresh" }]);
    expect(routes.some((r) => /order/i.test(r.url))).toBe(false);
  });
});

describe("GET /api/health", () => {
  it("reports the IB connection", async () => {
    const res = await app.inject("/api/health");
    expect(res.json()).toEqual({ ok: true, ib: { connected: true, isDelayed: false } });
  });
});

describe("IB-backed routes", () => {
  it.each(["/api/pnl", "/api/activity", "/api/portfolio", "/api/search?q=a", "/api/history?symbol=A", "/api/symbol-info?symbol=A"])(
    "%s returns 503 while disconnected",
    async (url) => {
      ibMock.isConnected = false;
      const res = await app.inject(url);
      expect(res.statusCode).toBe(503);
    },
  );
});

describe("GET /api/pnl", () => {
  it.each([
    ["", 90],
    ["?days=365", 365],
    ["?days=0", 90],
    ["?days=abc", 90],
    ["?days=-5", 1],
    ["?days=99999", 1825],
  ])("days%s → %i", async (qs, days) => {
    await app.inject(`/api/pnl${qs}`);
    expect(getPnlHistory).toHaveBeenCalledWith(days);
  });
});

describe("POST /api/pnl/refresh", () => {
  it("forces a Flex fetch and drops the P&L cache, even while disconnected", async () => {
    ibMock.isConnected = false;
    const res = await app.inject({ method: "POST", url: "/api/pnl/refresh" });
    expect(res.json()).toEqual({ ok: true, tradesAsOf: 123 });
    expect(getFlexTrades).toHaveBeenCalledWith({ force: true });
    expect(invalidatePnlCache).toHaveBeenCalled();
  });
});

describe("GET /api/activity", () => {
  it("returns the per-symbol activity", async () => {
    const res = await app.inject("/api/activity");
    expect(res.json()).toEqual({ symbols: [], tradesAsOf: 123 });
  });
});

describe("GET /api/portfolio", () => {
  it("returns the snapshot", async () => {
    const res = await app.inject("/api/portfolio");
    expect(res.json()).toEqual({ account: "U1", balances: {}, positions: [] });
  });
});

describe("market routes", () => {
  it("search trims the query and short-circuits empty ones", async () => {
    expect((await app.inject("/api/search?q=%20%20")).json()).toEqual({ matches: [] });
    expect(searchSymbols).not.toHaveBeenCalled();
    expect((await app.inject("/api/search?q=%20aapl%20")).json()).toEqual({ matches: [{ symbol: "AAPL" }] });
    expect(searchSymbols).toHaveBeenCalledWith("aapl");
  });

  it("symbol-info parses the conId", async () => {
    await app.inject("/api/symbol-info?conId=42");
    expect(getSymbolInfo).toHaveBeenCalledWith({ symbol: undefined, conId: 42 });
  });

  it("history defaults to 6 months of daily RTH bars", async () => {
    const res = await app.inject("/api/history?symbol=AAPL");
    expect(res.json()).toEqual({
      contract: { symbol: "AAPL" },
      isDelayed: false,
      bars: [{ time: 1, close: 1 }],
    });
    expect(getHistory).toHaveBeenCalledWith({
      contract: { symbol: "AAPL", conId: undefined },
      barSize: "1 day",
      duration: "6 M",
      useRTH: true,
    });
  });

  it("history honours explicit bar size, duration and rth=0", async () => {
    await app.inject("/api/history?conId=7&barSize=5%20mins&duration=1%20D&rth=0");
    expect(getHistory).toHaveBeenCalledWith({
      contract: { symbol: undefined, conId: 7 },
      barSize: "5 mins",
      duration: "1 D",
      useRTH: false,
    });
  });
});

describe("WS /ws/quotes", () => {
  const nextMessage = (ws: { once: (e: "message", cb: (d: Buffer) => void) => void }) =>
    new Promise<Record<string, unknown>>((resolve) =>
      ws.once("message", (d: Buffer) => resolve(JSON.parse(d.toString()))),
    );

  it("streams quotes for a subscription and stops on unsubscribe", async () => {
    const upstream = new Subject<Quote>();
    vi.mocked(streamQuote).mockReturnValue(upstream);
    const ws = await app.injectWS("/ws/quotes");

    ws.send(JSON.stringify({ type: "subscribe", symbol: "aapl" }));
    await vi.waitFor(() => expect(upstream.observed).toBe(true));
    const msg = nextMessage(ws);
    upstream.next({ last: 100, delayed: false });
    expect(await msg).toEqual({
      type: "quote",
      key: "sym:AAPL",
      symbol: "aapl",
      quote: { last: 100, delayed: false },
    });

    ws.send(JSON.stringify({ type: "unsubscribe", symbol: "AAPL" }));
    await vi.waitFor(() => expect(upstream.observed).toBe(false));
    ws.terminate();
  });

  it("reports subscription errors to the client", async () => {
    const ws = await app.injectWS("/ws/quotes");
    const msg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe" }));
    expect(await msg).toEqual({
      type: "error",
      key: "sym:undefined",
      message: "Either conId or symbol is required",
    });
    ws.terminate();
  });
});
