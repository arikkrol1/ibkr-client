import type { FastifyInstance } from "fastify";
import { ib } from "../ib/connection.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => {
    return { ok: true, ib: ib.health() };
  });
}
