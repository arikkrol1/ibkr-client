import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";
import { getPnlHistory, invalidatePnlCache } from "../ib/pnlHistory.js";
import { getFlexTrades, tradesAsOf } from "../ib/flex.js";

export async function registerPnlRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { days?: string } }>("/api/pnl", async (req) => {
    if (!ib.isConnected) {
      const err = new Error("Not connected to IB Gateway / TWS");
      (err as Error & { statusCode?: number }).statusCode = 503;
      throw err;
    }
    const days = Math.min(Math.max(Number(req.query.days ?? 90) || 90, 1), 1825);
    return getPnlHistory(days);
  });

  // Force a Flex re-fetch (subject to the rate limiter and any lockout
  // cooldown). Doesn't need the IB Gateway connection.
  app.post("/api/pnl/refresh", async () => {
    await getFlexTrades({ force: true });
    invalidatePnlCache();
    return { ok: true, tradesAsOf: await tradesAsOf() };
  });
}
