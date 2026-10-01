import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";
import { getActivity } from "../ib/activity.js";

export async function registerActivityRoutes(app: FastifyInstance) {
  app.get("/api/activity", async () => {
    // The trades come from storage, but charting them needs IB's daily bars.
    if (!ib.isConnected) {
      const err = new Error("Not connected to IB Gateway / TWS");
      (err as Error & { statusCode?: number }).statusCode = 503;
      throw err;
    }
    return getActivity();
  });
}
