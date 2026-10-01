import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { ib } from "./ib/connection.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMarketRoutes } from "./routes/market.js";
import { registerQuoteRoutes } from "./routes/quotes.js";
import { registerPortfolioRoutes } from "./routes/portfolio.js";
import { registerPnlRoutes } from "./routes/pnl.js";
import { registerActivityRoutes } from "./routes/activity.js";

async function main() {
  const app = Fastify({ logger: { level: "warn" } });

  // localhost-only app; allow the Vite dev origin during development.
  await app.register(cors, { origin: true });
  await app.register(websocket);

  await app.register(registerHealthRoutes);
  await app.register(registerMarketRoutes);
  await app.register(registerQuoteRoutes);
  await app.register(registerPortfolioRoutes);
  await app.register(registerPnlRoutes);
  await app.register(registerActivityRoutes);

  // Serve the built frontend in production (single origin). In dev, Vite serves it.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist });
    // SPA fallback: send index.html for non-API/WS client routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
    console.log(`[http] serving web UI from ${webDist}`);
  }

  // Kick off the IB connection (auto-reconnects in the background).
  ib.connect();

  await app.listen({ port: config.httpPort, host: "127.0.0.1" });
  console.log(`[http] listening on http://127.0.0.1:${config.httpPort}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
