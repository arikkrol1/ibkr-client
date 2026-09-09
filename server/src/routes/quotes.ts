import type { FastifyInstance } from "fastify";
import type { Subscription } from "rxjs";
import { resolveContract } from "../ib/contracts.js";
import { streamQuote, type Quote } from "../ib/marketData.js";

interface ClientMsg {
  type: "subscribe" | "unsubscribe";
  symbol?: string;
  conId?: number;
}

/**
 * WS /ws/quotes — client sends {type:'subscribe', symbol|conId}. Server streams
 * {type:'quote', key, symbol, quote} messages until unsubscribed or disconnected.
 */
export async function registerQuoteRoutes(app: FastifyInstance) {
  app.get("/ws/quotes", { websocket: true }, (socket) => {
    const subs = new Map<string, Subscription>();

    const send = (obj: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    };

    socket.on("message", (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const key = msg.conId ? `id:${msg.conId}` : `sym:${msg.symbol?.toUpperCase()}`;

      if (msg.type === "subscribe") {
        if (subs.has(key)) return;
        try {
          const contract = resolveContract({ symbol: msg.symbol, conId: msg.conId });
          const sub = streamQuote(contract).subscribe({
            next: (quote: Quote) =>
              send({ type: "quote", key, symbol: msg.symbol, quote }),
            error: (err) =>
              send({ type: "error", key, message: String(err?.message ?? err) }),
          });
          subs.set(key, sub);
        } catch (err) {
          send({ type: "error", key, message: String((err as Error).message) });
        }
      } else if (msg.type === "unsubscribe") {
        subs.get(key)?.unsubscribe();
        subs.delete(key);
      }
    });

    socket.on("close", () => {
      for (const sub of subs.values()) sub.unsubscribe();
      subs.clear();
    });
  });
}
