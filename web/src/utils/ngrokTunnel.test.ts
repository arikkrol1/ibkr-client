import { describe, expect, it } from "vitest";
import { ngrokArgs, parseAllowedEmails, parseNgrokLog, renderPolicy } from "./ngrokTunnel";

describe("parseAllowedEmails", () => {
  it("splits, trims, lowercases and drops blanks", () => {
    expect(parseAllowedEmails(" A@x.com , b.c+tag@y.co,")).toEqual(["a@x.com", "b.c+tag@y.co"]);
  });

  it("returns [] when unset", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
    expect(parseAllowedEmails("  ")).toEqual([]);
  });

  it.each(["x' or true", "a@b.c']) || true || (['", 'a"b@x.com', "a b@x.com", "nope"])(
    "rejects %s",
    (raw) => expect(() => parseAllowedEmails(raw)).toThrow(/invalid email/),
  );
});

describe("renderPolicy", () => {
  it("requires Google login then denies everyone not listed", () => {
    const policy = JSON.parse(renderPolicy(["a@x.com", "b@y.co"]));
    expect(policy.on_http_request[0].actions[0]).toEqual({
      type: "oauth",
      config: { provider: "google" },
    });
    expect(policy.on_http_request[1]).toEqual({
      expressions: ["!(actions.ngrok.oauth.identity.email in ['a@x.com', 'b@y.co'])"],
      actions: [{ type: "deny", config: { status_code: 403 } }],
    });
  });

  it("refuses an empty allow-list", () => {
    expect(() => renderPolicy([])).toThrow();
  });
});

describe("ngrokArgs", () => {
  it("tunnels the port with the policy and JSON logs", () => {
    expect(ngrokArgs({ port: 5173, policyPath: "/p.json" })).toEqual([
      "http", "5173", "--traffic-policy-file", "/p.json", "--log", "stdout", "--log-format", "json",
    ]);
  });

  it("adds a normalised static domain", () => {
    const args = ngrokArgs({ port: 5173, policyPath: "/p.json", domain: " https://me.ngrok-free.app/ " });
    expect(args.slice(4, 6)).toEqual(["--url", "me.ngrok-free.app"]);
  });
});

describe("parseNgrokLog", () => {
  it("extracts the public URL", () => {
    const line = JSON.stringify({ lvl: "info", msg: "started tunnel", url: "https://me.ngrok-free.app" });
    expect(parseNgrokLog(line)).toEqual({ url: "https://me.ngrok-free.app" });
  });

  it("surfaces errors", () => {
    const line = JSON.stringify({ lvl: "eror", msg: "session closed", err: "ERR_NGROK_108" });
    expect(parseNgrokLog(line)).toEqual({ error: "ERR_NGROK_108" });
  });

  it("ignores other lines and non-JSON", () => {
    expect(parseNgrokLog(JSON.stringify({ lvl: "info", msg: "client session established" }))).toBeNull();
    expect(parseNgrokLog("plain text")).toBeNull();
  });
});
