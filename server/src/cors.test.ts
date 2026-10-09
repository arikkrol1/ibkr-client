import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { corsOptions, isAllowedOrigin } from "./cors.js";

describe("isAllowedOrigin", () => {
  it.each([undefined, "http://localhost:5173", "http://127.0.0.1:4010", "https://localhost"])(
    "allows %s",
    (origin) => expect(isAllowedOrigin(origin)).toBe(true),
  );

  it.each([
    "https://evil.example",
    "https://my-dash.ngrok-free.app",
    "http://localhost.evil.example",
    "file://localhost",
    "null",
    "not a url",
  ])("rejects %s", (origin) => expect(isAllowedOrigin(origin)).toBe(false));
});

describe("CORS headers", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    await app.register(cors, corsOptions);
    app.get("/api/x", async () => ({ ok: true }));
    await app.ready();
  });

  afterEach(() => app.close());

  it("reflects a local dev origin", async () => {
    const res = await app.inject({ url: "/api/x", headers: { origin: "http://localhost:5173" } });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("sends no CORS headers to a foreign origin", async () => {
    const res = await app.inject({ url: "/api/x", headers: { origin: "https://evil.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
