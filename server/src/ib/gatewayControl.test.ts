import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";

vi.mock("./connection.js", () => ({ ib: { reconnect: vi.fn(), isConnected: false } }));

import { createGatewayControl, sendIbcCommand, type GatewayControlDeps } from "./gatewayControl.js";

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

function setup(over: Partial<GatewayControlDeps> = {}) {
  let t = 1_000_000;
  const deps = {
    restartEnabled: vi.fn(() => true),
    sendCommand: vi.fn(async () => "OK RESTART in progress"),
    startGateway: vi.fn(),
    reconnectApi: vi.fn(),
    isApiConnected: vi.fn(() => false),
    cooldownMs: 90_000,
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
    expect(gc.status()).toMatchObject({ restarting: true, lastAction: { action: "restart", ok: true } });
  });

  it("cold-starts Gateway when IBC refuses the connection", async () => {
    const { gc, deps } = setup({ sendCommand: vi.fn(async () => Promise.reject(refused())) });
    expect(await gc.restart()).toEqual({ status: "restarting", mode: "start" });
    expect(deps.startGateway).toHaveBeenCalledOnce();
    expect(gc.status().lastAction).toMatchObject({ action: "start", ok: true });
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

  it("rate-limits repeated requests, then allows one after the cooldown", async () => {
    const { gc, deps, advance } = setup();
    await gc.restart();
    advance(30_000);
    expect(await gc.restart()).toEqual({ status: "cooldown", retryAfterSec: 60 });
    advance(60_000);
    expect((await gc.restart()).status).toBe("restarting");
    expect(deps.sendCommand).toHaveBeenCalledTimes(2);
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

  it("times out when IBC never replies", async () => {
    const ibc = await fakeIbc(() => "");
    await expect(sendIbcCommand(ibc.port, "RESTART", 200)).rejects.toThrow(/did not reply/);
  });
});
