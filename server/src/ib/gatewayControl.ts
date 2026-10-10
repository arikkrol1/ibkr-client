import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { ib } from "./connection.js";

/**
 * Reconnect / restart IB Gateway from the UI.
 *
 * - reconnect: drop and reopen our API socket (Gateway itself untouched).
 * - restart: send IBC the fixed `RESTART` command (Gateway logs back in by
 *   itself, no 2FA, ~1 min). If IBC's command port refuses the connection,
 *   Gateway isn't running under IBC, so cold-start it via scripts/ibc.sh
 *   (needs the IB Key 2FA approval).
 * - fallback: the no-2FA restart relies on an auto-restart token that IBKR
 *   expires on its own schedule. When it's rejected, Gateway sits at a login
 *   error that IBC doesn't handle. So if the API isn't back `fallbackMs` after
 *   a RESTART, stop Gateway (IBC STOP, then kill if needed) and cold-start it.
 *
 * Only fixed commands are ever sent; nothing comes from the request. Restarts
 * are rate-limited so repeated taps can't stack restarts or 2FA pushes.
 */

export type GatewayAction = "reconnect" | "restart" | "start" | "fallback";

export interface LastAction {
  action: GatewayAction;
  at: number;
  ok: boolean;
  message?: string;
}

export type RestartResult =
  | { status: "restarting"; mode: "restart" | "start" }
  | { status: "disabled"; message: string }
  | { status: "cooldown"; retryAfterSec: number }
  | { status: "error"; message: string };

/** What a restart in flight is doing; `start` means waiting on IB Key 2FA. */
export type GatewayPhase = "idle" | "restart" | "start";

export interface GatewayStatus {
  restartEnabled: boolean;
  /** A restart/start was requested within the cooldown window. */
  restarting: boolean;
  phase: GatewayPhase;
  lastAction: LastAction | null;
}

export interface GatewayControlDeps {
  restartEnabled: () => boolean;
  /** Send one IBC command; rejects with `code: "ECONNREFUSED"` when IBC isn't running. */
  sendCommand: (cmd: "RESTART" | "STOP") => Promise<string>;
  /** Is IBC's command port accepting connections? */
  isIbcUp: () => Promise<boolean>;
  /** Cold-start Gateway under IBC (detached). */
  startGateway: () => void;
  /** Last resort when IBC won't stop: kill the Gateway process. */
  killGateway: () => void;
  reconnectApi: () => void;
  isApiConnected: () => boolean;
  cooldownMs: number;
  /** How long a RESTART gets to bring the API back before the fallback. */
  fallbackMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createGatewayControl(deps: GatewayControlDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastAction: LastAction | null = null;
  let busyUntil = 0;
  let phase: GatewayPhase = "idle";

  const record = (action: GatewayAction, ok: boolean, message?: string) => {
    lastAction = { action, at: now(), ok, ...(message ? { message } : {}) };
  };

  const coldStart = () => {
    deps.startGateway();
    phase = "start";
    busyUntil = now() + deps.cooldownMs;
  };

  /** After a RESTART: if the API isn't back in time, stop Gateway and cold-start it. */
  const watchRestart = async () => {
    await sleep(deps.fallbackMs);
    if (deps.isApiConnected()) {
      phase = "idle";
      return;
    }
    record("fallback", true, "auto-restart didn't reconnect (login token rejected?); stopping Gateway for a fresh login");
    await deps.sendCommand("STOP").catch(() => undefined);
    for (let i = 0; i < 30 && (await deps.isIbcUp()); i++) await sleep(1000);
    if (await deps.isIbcUp()) {
      deps.killGateway();
      await sleep(3000);
    }
    coldStart();
    record("start", true, "fresh login after failed auto-restart: approve the IB Key notification");
  };

  return {
    reconnect(): void {
      deps.reconnectApi();
      record("reconnect", true);
    },

    async restart(): Promise<RestartResult> {
      if (!deps.restartEnabled()) {
        return { status: "disabled", message: "IBC is not installed (see README → IBC)" };
      }
      const t = now();
      if (t < busyUntil) {
        return { status: "cooldown", retryAfterSec: Math.ceil((busyUntil - t) / 1000) };
      }
      busyUntil = t + deps.cooldownMs; // claim before awaiting: single-flight

      try {
        await deps.sendCommand("RESTART");
        record("restart", true);
        phase = "restart";
        // The fallback may outlast the cooldown; keep further requests out until it's settled.
        busyUntil = Math.max(busyUntil, t + deps.fallbackMs + deps.cooldownMs);
        void watchRestart().catch((err) => {
          phase = "idle";
          record("fallback", false, (err as Error).message);
        });
        return { status: "restarting", mode: "restart" };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
          busyUntil = 0;
          const message = `IBC command failed: ${(err as Error).message}`;
          record("restart", false, message);
          return { status: "error", message };
        }
        // IBC isn't listening. If the API still answers, Gateway was started
        // outside IBC and a cold start would collide with it.
        if (deps.isApiConnected()) {
          busyUntil = 0;
          const message = "IB Gateway is running outside IBC; quit it, then run pnpm ibc";
          record("start", false, message);
          return { status: "error", message };
        }
        coldStart();
        record("start", true);
        return { status: "restarting", mode: "start" };
      }
    },

    status(): GatewayStatus {
      const restarting = now() < busyUntil;
      // Once connected again (or the window has passed) nothing is in flight.
      if (phase !== "idle" && (!restarting || (phase === "start" && deps.isApiConnected()))) phase = "idle";
      return { restartEnabled: deps.restartEnabled(), restarting, phase, lastAction };
    },
  };
}

export type GatewayControl = ReturnType<typeof createGatewayControl>;

/** Send one command to IBC's command server and resolve with its first reply line. */
export function sendIbcCommand(port: number, cmd: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: "127.0.0.1", port });
    let buf = "";
    const done = (fn: () => void) => {
      sock.removeAllListeners();
      sock.end("EXIT\n");
      sock.destroy();
      fn();
    };
    sock.setTimeout(timeoutMs, () => done(() => reject(new Error("IBC did not reply"))));
    sock.on("connect", () => sock.write(`${cmd}\n`));
    sock.on("data", (d) => {
      buf += d.toString();
      const line = buf.split(/\r?\n/).find((l) => /^(OK|ERROR)\b/.test(l));
      if (!line) return;
      done(() => (line.startsWith("OK") ? resolve(line) : reject(new Error(line))));
    });
    sock.on("error", (err) => done(() => reject(err)));
  });
}

/** Does anything accept TCP connections on this local port? */
export function isPortOpen(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on("connect", () => finish(true));
    sock.on("error", () => finish(false));
  });
}

// Real wiring. scripts/ibc.sh sits at the repo root: three levels up from
// server/src/ib (dev) and server/dist/ib (built).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ibcScript = join(repoRoot, "scripts", "ibc.sh");

export const gatewayControl = createGatewayControl({
  restartEnabled: () =>
    existsSync(join(config.ibc.path, "gatewaystartmacos.sh")) && existsSync(ibcScript),
  sendCommand: (cmd) => sendIbcCommand(config.ibc.commandPort, cmd),
  isIbcUp: () => isPortOpen(config.ibc.commandPort),
  startGateway: () => {
    const logDir = join(config.ibc.path, "logs");
    mkdirSync(logDir, { recursive: true });
    const out = openSync(join(logDir, "dashboard-start.out"), "a");
    spawn("bash", [ibcScript, "start"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        IBC_PATH: config.ibc.path,
        IBC_COMMAND_PORT: String(config.ibc.commandPort),
        IB_PORT: String(config.ib.port),
      },
    }).unref();
  },
  killGateway: () => {
    spawnSync("pkill", ["-f", "IB Gateway"]);
  },
  reconnectApi: () => ib.reconnect(),
  isApiConnected: () => ib.isConnected,
  cooldownMs: config.ibc.restartCooldownSec * 1000,
  fallbackMs: config.ibc.restartFallbackSec * 1000,
});
