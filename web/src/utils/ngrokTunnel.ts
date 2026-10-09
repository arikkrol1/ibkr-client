/**
 * Pure helpers for the dev-server ngrok tunnel (see `web/vite-plugin-ngrok.ts`).
 * They live here, not in the plugin, so they're unit-tested.
 */

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;

/**
 * Parse NGROK_ALLOWED_EMAILS ("a@x.com, b@y.com") into lowercase emails.
 * Throws on anything that isn't a plain address, because the values end up
 * inside a traffic-policy expression.
 */
export function parseAllowedEmails(raw: string | undefined): string[] {
  const emails = (raw ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  for (const e of emails) {
    if (!EMAIL.test(e)) throw new Error(`invalid email in NGROK_ALLOWED_EMAILS: ${e}`);
  }
  return emails.map((e) => e.toLowerCase());
}

/**
 * ngrok Traffic Policy: every request must pass Google login at ngrok's edge,
 * and only the allowed emails get through (everyone else gets 403).
 * Returned as JSON, which ngrok accepts as a policy file.
 */
export function renderPolicy(emails: string[]): string {
  if (emails.length === 0) throw new Error("no allowed emails");
  const list = emails.map((e) => `'${e}'`).join(", ");
  const policy = {
    on_http_request: [
      { actions: [{ type: "oauth", config: { provider: "google" } }] },
      {
        expressions: [`!(actions.ngrok.oauth.identity.email in [${list}])`],
        actions: [{ type: "deny", config: { status_code: 403 } }],
      },
    ],
  };
  return JSON.stringify(policy, null, 2);
}

/** CLI args for `ngrok http`, logging JSON to stdout so we can read the URL. */
export function ngrokArgs(opts: { port: number; domain?: string; policyPath: string }): string[] {
  const args = ["http", String(opts.port), "--traffic-policy-file", opts.policyPath];
  const domain = opts.domain?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain) args.push("--url", domain);
  args.push("--log", "stdout", "--log-format", "json");
  return args;
}

export interface NgrokLogEvent {
  url?: string;
  error?: string;
}

/** Pick the public URL or an error out of one line of ngrok's JSON log. */
export function parseNgrokLog(line: string): NgrokLogEvent | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec.msg === "started tunnel" && typeof rec.url === "string") return { url: rec.url };
  if (rec.lvl === "eror" || rec.lvl === "crit" || rec.lvl === "error") {
    return { error: String(rec.err ?? rec.msg ?? line) };
  }
  return null;
}
