import { describe, expect, it } from "vitest";
import { NAV_TABS } from "./nav";

describe("NAV_TABS", () => {
  it("lists the six tabs in order, starting at the dashboard", () => {
    expect(NAV_TABS.map((t) => t.path)).toEqual(["/", "/pnl", "/activity", "/compare", "/chart", "/sectors"]);
  });

  it("has unique paths", () => {
    expect(new Set(NAV_TABS.map((t) => t.path)).size).toBe(NAV_TABS.length);
  });

  it("keeps bottom-bar labels short enough for a phone", () => {
    for (const t of NAV_TABS) expect(t.short.length).toBeLessThanOrEqual(8);
  });
});
