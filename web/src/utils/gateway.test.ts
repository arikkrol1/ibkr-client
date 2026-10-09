import { describe, expect, it } from "vitest";
import { lastActionText, restartMessage } from "./gateway";

describe("restartMessage", () => {
  it("asks for the IB Key approval on a cold start", () => {
    expect(restartMessage("start")).toMatch(/approve the IB Key/);
  });

  it("promises about a minute for an in-place restart", () => {
    expect(restartMessage("restart")).toMatch(/about a minute/);
  });
});

describe("lastActionText", () => {
  const now = 10_000_000;

  it("is null before any action", () => {
    expect(lastActionText(null, now)).toBeNull();
  });

  it.each([
    [10_000, "Restart just now"],
    [3 * 60_000, "Restart 3 min ago"],
    [2 * 3_600_000, "Restart 2 h ago"],
    [3 * 86_400_000, "Restart 3 d ago"],
  ])("formats an action %ims ago as %s", (age, text) => {
    expect(lastActionText({ action: "restart", at: now - age, ok: true }, now)).toBe(text);
  });

  it("shows the failure reason", () => {
    expect(
      lastActionText({ action: "start", at: now, ok: false, message: "running outside IBC" }, now),
    ).toBe("Start failed: running outside IBC");
  });
});
