import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });

function stubFetch(res: Response) {
  // A body can only be read once — hand out a fresh copy per call.
  const fn = vi.fn(async () => res.clone());
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("builds query strings for each endpoint", async () => {
    const fetch = stubFetch(json({}));
    await api.search("brk b");
    await api.symbolInfo({ conId: 5 });
    await api.history({ symbol: "AAPL", barSize: "1 day", duration: "6 M" });
    await api.pnl(365);
    expect(fetch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      "/api/search?q=brk%20b",
      "/api/symbol-info?conId=5",
      "/api/history?symbol=AAPL&barSize=1+day&duration=6+M",
      "/api/pnl?days=365",
    ]);
  });

  it("returns parsed JSON", async () => {
    stubFetch(json({ ok: true, ib: { connected: true } }));
    expect(await api.health()).toEqual({ ok: true, ib: { connected: true } });
  });

  it("surfaces the server's error message", async () => {
    stubFetch(json({ message: "Not connected to IB Gateway / TWS" }, { status: 503 }));
    await expect(api.portfolio()).rejects.toThrow("Not connected to IB Gateway / TWS");
  });

  it("falls back to the HTTP status when the body isn't JSON", async () => {
    stubFetch(new Response("oops", { status: 500, statusText: "Internal Server Error" }));
    await expect(api.pnl(90)).rejects.toThrow("500 Internal Server Error");
  });

  it("POSTs the P&L refresh", async () => {
    const fetch = stubFetch(json({ ok: true, tradesAsOf: 1 }));
    expect(await api.pnlRefresh()).toEqual({ ok: true, tradesAsOf: 1 });
    expect(fetch).toHaveBeenCalledWith("/api/pnl/refresh", { method: "POST" });
  });

  it("reports refresh failures", async () => {
    stubFetch(json({ message: "Flex rate limit" }, { status: 500 }));
    await expect(api.pnlRefresh()).rejects.toThrow("Flex rate limit");
  });

  it("POSTs Gateway reconnect / restart as JSON", async () => {
    const fetch = stubFetch(json({ ok: true, mode: "start" }, { status: 202 }));
    expect(await api.ibRestart()).toEqual({ ok: true, mode: "start" });
    await api.ibReconnect();
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    expect(fetch.mock.calls).toEqual([
      ["/api/ib/restart", init],
      ["/api/ib/reconnect", init],
    ]);
  });

  it("surfaces the restart cooldown message", async () => {
    stubFetch(json({ message: "Restart already requested; try again in 42s" }, { status: 429 }));
    await expect(api.ibRestart()).rejects.toThrow("try again in 42s");
  });
});
