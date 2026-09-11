import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";
import { getPnlHistory } from "../ib/pnlHistory.js";

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
}
