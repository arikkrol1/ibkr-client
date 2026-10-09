import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, type Plugin } from "vite";
import { ngrokArgs, parseAllowedEmails, parseNgrokLog, renderPolicy } from "./src/utils/ngrokTunnel";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/**
 * Dev-only: when the Vite dev server starts, open an ngrok tunnel to it, so
 * `pnpm dev` serves the same app to desktop (localhost) and phone (ngrok URL).
 * ngrok requires Google login and only lets NGROK_ALLOWED_EMAILS through.
 *
 * Config is read from server/.env (or the environment). Without
 * NGROK_ALLOWED_EMAILS, or without the ngrok CLI, the tunnel is skipped and
 * dev carries on as normal.
 */
export function ngrokTunnel(): Plugin {
  let child: ChildProcess | undefined;
  const stop = () => {
    child?.kill();
    child = undefined;
  };

  return {
    name: "ngrok-tunnel",
    apply: "serve",
    configureServer(server) {
      const env = { ...loadEnv("development", join(repoRoot, "server"), "NGROK_"), ...pickNgrokEnv() };
      const log = (msg: string) => server.config.logger.info(`  \x1b[35m➜\x1b[0m  ${msg}`);

      let emails: string[];
      try {
        emails = parseAllowedEmails(env.NGROK_ALLOWED_EMAILS);
      } catch (err) {
        server.config.logger.error(`[ngrok] ${(err as Error).message}; tunnel disabled`);
        return;
      }
      if (emails.length === 0) {
        log("Mobile:  tunnel off (set NGROK_ALLOWED_EMAILS in server/.env)");
        return;
      }

      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const port = typeof addr === "object" && addr ? addr.port : server.config.server.port ?? 5173;

        const policyPath = join(repoRoot, ".ngrok", "policy.json");
        mkdirSync(dirname(policyPath), { recursive: true });
        writeFileSync(policyPath, renderPolicy(emails));

        child = spawn("ngrok", ngrokArgs({ port, domain: env.NGROK_DOMAIN, policyPath }), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("error", (err) => {
          server.config.logger.warn(`[ngrok] not started (${err.message}); is the ngrok CLI installed?`);
          child = undefined;
        });
        // ngrok repeats errors (JSON log + a stderr copy), so report each once.
        const seen = new Set<string>();
        const stderr: string[] = [];
        child.on("exit", (code) => {
          if (!child) return;
          if (seen.size === 0 && stderr.length) server.config.logger.warn(`[ngrok] ${stderr.join("\n")}`);
          server.config.logger.warn(`[ngrok] tunnel exited (code ${code}); dev server keeps running`);
          child = undefined;
        });
        createInterface({ input: child.stdout! }).on("line", (line) => {
          const ev = parseNgrokLog(line);
          if (ev?.url) log(`Mobile:  \x1b[36m${ev.url}\x1b[0m  (Google login: ${emails.join(", ")})`);
          if (ev?.error && !seen.has(ev.error)) {
            seen.add(ev.error);
            server.config.logger.warn(`[ngrok] ${ev.error}`);
          }
        });
        createInterface({ input: child.stderr! }).on("line", (line) => stderr.push(line));
      });

      server.httpServer?.once("close", stop);
      process.once("exit", stop);
    },
  };
}

/** NGROK_* vars already in the process environment win over server/.env. */
function pickNgrokEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[0].startsWith("NGROK_") && typeof e[1] === "string",
    ),
  );
}
