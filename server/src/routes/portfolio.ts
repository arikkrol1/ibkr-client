import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";
import { getPortfolio } from "../ib/portfolio.js";

export async function registerPortfolioRoutes(app: FastifyInstance) {
  app.get("/api/portfolio", async () => {
    if (!ib.isConnected) {
      const err = new Error("Not connected to IB Gateway / TWS");
      (err as Error & { statusCode?: number }).statusCode = 503;
      throw err;
    }
    return getPortfolio();
  });
}
