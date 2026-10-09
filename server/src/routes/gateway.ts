import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { gatewayControl } from "../ib/gatewayControl.js";

/**
 * Reconnect / restart IB Gateway. These are the only mutating routes besides
 * the Flex refresh; neither touches orders. They require a JSON content type,
 * so a cross-site form POST can't trigger them, and a cross-site fetch has to
 * pass a CORS preflight, which foreign origins fail.
 */
async function requireJson(req: FastifyRequest, reply: FastifyReply) {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    return reply.code(415).send({ message: "Content-Type must be application/json" });
  }
}

export async function registerGatewayRoutes(app: FastifyInstance) {
  app.post("/api/ib/reconnect", { preHandler: requireJson }, async () => {
    gatewayControl.reconnect();
    return { ok: true };
  });

  app.post("/api/ib/restart", { preHandler: requireJson }, async (_req, reply) => {
    const result = await gatewayControl.restart();
    switch (result.status) {
      case "restarting":
        return reply.code(202).send({ ok: true, mode: result.mode });
      case "disabled":
        return reply.code(501).send({ message: result.message });
      case "cooldown":
        return reply
          .code(429)
          .header("retry-after", String(result.retryAfterSec))
          .send({ message: `Restart already requested; try again in ${result.retryAfterSec}s` });
      case "error":
        return reply.code(409).send({ message: result.message });
    }
  });
}
