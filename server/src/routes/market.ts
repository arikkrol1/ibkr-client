import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";
import { searchSymbols, resolveContract, getSymbolInfo } from "../ib/contracts.js";
import { getHistory } from "../ib/marketData.js";

function requireConnected() {
  if (!ib.isConnected) {
    const err = new Error("Not connected to IB Gateway / TWS");
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }
}

export async function registerMarketRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) => {
    requireConnected();
    const q = (req.query.q ?? "").trim();
    if (q.length < 1) return { matches: [] };
    const matches = await searchSymbols(q);
    return { matches };
  });

  app.get<{ Querystring: { symbol?: string; conId?: string } }>(
    "/api/symbol-info",
    async (req) => {
      requireConnected();
      const { symbol, conId } = req.query;
      return getSymbolInfo({ symbol, conId: conId ? Number(conId) : undefined });
    },
  );

  app.get<{
    Querystring: {
      symbol?: string;
      conId?: string;
      currency?: string;
      exchange?: string;
      barSize?: string;
      duration?: string;
      rth?: string;
    };
  }>("/api/history", async (req) => {
    requireConnected();
    const { symbol, conId, currency, exchange, barSize, duration, rth } = req.query;
    const contract = resolveContract({
      symbol,
      conId: conId ? Number(conId) : undefined,
      currency,
      exchange,
    });
    const bars = await getHistory({
      contract,
      barSize: barSize ?? "1 day",
      duration: duration ?? "6 M",
      useRTH: rth !== "0",
    });
    return {
      contract: { symbol: contract.symbol, conId: contract.conId },
      isDelayed: ib.health().isDelayed,
      bars,
    };
  });
}
