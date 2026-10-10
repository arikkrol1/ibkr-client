import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";

vi.mock("./connection.js", () => ({ ib: { reconnect: vi.fn(), isConnected: false } }));

import { createGatewayControl, isPortOpen, sendIbcCommand, type GatewayControlDeps } from "./gatewayControl.js";

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

function setup(over: Partial<GatewayControlDeps> = {}) {
  let t = 1_000_000;
  const deps = {
    restartEnabled: vi.fn(() => true),
    sendCommand: vi.fn(async (_cmd: "RESTART" | "STOP") => "OK"),
    isIbcUp: vi.fn(async () => false),
    startGateway: vi.fn(),
    killGateway: vi.fn(),
    reconnectApi: vi.fn(),
    isApiConnected: vi.fn(() => false),
    cooldownMs: 90_000,
    fallbackMs: 180_000,
    // By default the post-RESTART watch never wakes; fallback tests override it.
    sleep: vi.fn(() => new Promise<void>(() => {})),
    now: () => t,
    ...over,
  };
  const gc = createGatewayControl(deps);
  return { gc, deps, advance: (ms: number) => (t += ms) };
}

describe("restart", () => {
  it("sends exactly RESTART to IBC when it's running", async () => {
    const { gc, deps } = setup();
    expect(await gc.restart()).toEqual({ status: "restarting", mode: "restart" });
    expect(deps.sendCommand).toHaveBeenCalledWith("RESTART");
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(gc.status()).toMatchObject({
      restarting: true,
      phase: "restart",
      lastAction: { action: "restart", ok: true },
    });
  });

  it("cold-starts Gateway when IBC refuses the connection", async () => {
    const { gc, deps } = setup({ sendCommand: vi.fn(async () => Promise.reject(refused())) });
    expect(await gc.restart()).toEqual({ status: "restarting", mode: "start" });
    expect(deps.startGateway).toHaveBeenCalledOnce();
    expect(gc.status()).toMatchObject({ phase: "start", lastAction: { action: "start", ok: true } });
  });

  it("won't cold-start next to a Gateway running outside IBC", async () => {
    const { gc, deps } = setup({
      sendCommand: vi.fn(async () => Promise.reject(refused())),
      isApiConnected: vi.fn(() => true),
    });
    const res = await gc.restart();
    expect(res).toMatchObject({ status: "error", message: expect.stringMatching(/outside IBC/) });
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(gc.status().restarting).toBe(false);
  });

  it("reports other IBC errors and allows a retry", async () => {
    const { gc } = setup({ sendCommand: vi.fn(async () => Promise.reject(new Error("IBC did not reply"))) });
    expect(await gc.restart()).toMatchObject({ status: "error", message: expect.stringMatching(/did not reply/) });
    expect(gc.status()).toMatchObject({ restarting: false, lastAction: { action: "restart", ok: false } });
  });

  it("is disabled when IBC isn't installed", async () => {
    const { gc, deps } = setup({ restartEnabled: vi.fn(() => false) });
    expect((await gc.restart()).status).toBe("disabled");
    expect(deps.sendCommand).not.toHaveBeenCalled();
    expect(gc.status().restartEnabled).toBe(false);
  });

  it("rate-limits repeated cold starts, then allows one after the cooldown", async () => {
    const { gc, deps, advance } = setup({ sendCommand: vi.fn(async () => Promise.reject(refused())) });
    await gc.restart();
    advance(30_000);
    expect(await gc.restart()).toEqual({ status: "cooldown", retryAfterSec: 60 });
    advance(60_000);
    expect((await gc.restart()).status).toBe("restarting");
    expect(deps.startGateway).toHaveBeenCalledTimes(2);
  });

  it("blocks new requests until a RESTART's fallback window has passed", async () => {
    const { gc, advance } = setup();
    await gc.restart();
    advance(180_000);
    expect(await gc.restart()).toEqual({ status: "cooldown", retryAfterSec: 90 });
  });

  it("is single-flight while a request is in progress", async () => {
    let release!: () => void;
    const { gc, deps } = setup({
      sendCommand: vi.fn(() => new Promise<string>((r) => (release = () => r("OK")))),
    });
    const first = gc.restart();
    expect((await gc.restart()).status).toBe("cooldown");
    release();
    expect((await first).status).toBe("restarting");
    expect(deps.sendCommand).toHaveBeenCalledOnce();
  });
});

describe("fallback after RESTART", () => {
  /** Let the fire-and-forget watch run to completion. */
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const immediate = () => vi.fn(async (_ms: number) => {});

  it("does nothing when the API is back in time", async () => {
    const sleep = immediate();
    const { gc, deps } = setup({ sleep, isApiConnected: vi.fn(() => true) });
    await gc.restart();
    await settle();
    expect(sleep).toHaveBeenCalledWith(180_000);
    expect(deps.sendCommand).toHaveBeenCalledTimes(1); // just RESTART
    expect(deps.startGateway).not.toHaveBeenCalled();
    expect(gc.status().phase).toBe("idle");
  });

  it("stops Gateway via IBC and cold-starts it when the API didn't come back", async () => {
    const up = [true, true, false]; // IBC takes two polls to shut down
    const { gc, deps } = setup({
      sleep: immediate(),
      isIbcUp: vi.fn(async () => up.shift() ?? false),
    });
    await gc.restart();
    await settle();
    expect(vi.mocked(deps.sendCommand).mock.calls.map((c) => c[0])).toEqual(["RESTART", "STOP"]);
    expect(deps.killGateway).not.toHaveBeenCalled();
    expect(deps.startGateway).toHaveBeenCalledOnce();
    expect(gc.status()).toMatchObject({
      phase: "start",
      restarting: true,
      lastAction: { action: "start", ok: true, message: expect.stringMatching(/IB Key/) },
    });
  });

  it("kills Gateway when IBC won't stop", async () => {
    const { gc, deps } = setup({ sleep: immediate(), isIbcUp: vi.fn(async () => true) });
    await gc.restart();
    await settle();
    expect(deps.killGateway).toHaveBeenCalledOnce();
    expect(deps.startGateway).toHaveBeenCalledOnce();
  });

  it("still cold-starts if the STOP command itself fails", async () => {
    const sendCommand = vi.fn(async (cmd: "RESTART" | "STOP") =>
      cmd === "STOP" ? Promise.reject(refused()) : "OK",
    );
    const { gc, deps } = setup({ sleep: immediate(), sendCommand });
    await gc.restart();
    await settle();
    expect(deps.startGateway).toHaveBeenCalledOnce();
  });

  it("returns to idle once the cold start has reconnected", async () => {
    let connected = false;
    const { gc } = setup({ sleep: immediate(), isApiConnected: vi.fn(() => connected) });
    await gc.restart();
    await settle();
    expect(gc.status().phase).toBe("start");
    connected = true;
    expect(gc.status().phase).toBe("idle");
  });
});

describe("reconnect", () => {
  it("reopens the API socket and records it", () => {
    const { gc, deps } = setup();
    gc.reconnect();
    expect(deps.reconnectApi).toHaveBeenCalledOnce();
    expect(gc.status().lastAction).toMatchObject({ action: "reconnect", ok: true });
  });
});

describe("sendIbcCommand", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  /** A stand-in IBC command server on an ephemeral local port. */
  async function fakeIbc(reply: (cmd: string) => string): Promise<{ port: number; received: string[] }> {
    const received: string[] = [];
    server = createServer((sock) => {
      sock.on("data", (d) => {
        for (const line of d.toString().split("\n").filter(Boolean)) {
          received.push(line);
          if (line !== "EXIT") sock.write(reply(line));
        }
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    return { port: typeof addr === "object" && addr ? addr.port : 0, received };
  }

  it("sends the command and resolves with IBC's OK line", async () => {
    const ibc = await fakeIbc((cmd) => `OK ${cmd} in progress\n`);
    await expect(sendIbcCommand(ibc.port, "RESTART")).resolves.toBe("OK RESTART in progress");
    expect(ibc.received[0]).toBe("RESTART");
  });

  it("rejects on an ERROR reply", async () => {
    const ibc = await fakeIbc(() => "ERROR command not recognised\n");
    await expect(sendIbcCommand(ibc.port, "RESTART")).rejects.toThrow(/ERROR command/);
  });

  it("rejects with ECONNREFUSED when nothing is listening", async () => {
    const ibc = await fakeIbc(() => "");
    const port = ibc.port;
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await expect(sendIbcCommand(port, "RESTART")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("isPortOpen tells a listening port from a closed one", async () => {
    const ibc = await fakeIbc(() => "");
    expect(await isPortOpen(ibc.port)).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await isPortOpen(ibc.port)).toBe(false);
  });

  it("times out when IBC never replies", async () => {
    const ibc = await fakeIbc(() => "");
    await expect(sendIbcCommand(ibc.port, "RESTART", 200)).rejects.toThrow(/did not reply/);
  });
});
