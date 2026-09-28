import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pacing limiter and circuit breaker are module state — load a fresh copy
// for every test.
let mod: typeof import("./ibCall.js");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mod = await import("./ibCall.js");
});

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ibCall", () => {
  it("returns the call's result", async () => {
    await expect(mod.ibCall("x", 1000, async () => 42)).resolves.toBe(42);
  });

  it("propagates the call's error", async () => {
    await expect(mod.ibCall("x", 1000, async () => Promise.reject(new Error("nope")))).rejects.toThrow(
      "nope",
    );
  });

  it("rejects with IbTimeoutError when IB never answers", async () => {
    const p = mod.ibCall("getHistoricalData AAPL", 30_000, () => new Promise(() => {}));
    const assertion = expect(p).rejects.toBeInstanceOf(mod.IbTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    await expect(p).rejects.toThrow("getHistoricalData AAPL: no response from IB after 30s");
  });
});

describe("withHistorySlot", () => {
  it("runs at most two historical requests at once", async () => {
    const gates = Array.from({ length: 4 }, () => deferred());
    let running = 0;
    let peak = 0;
    const calls = gates.map((g, i) =>
      mod.withHistorySlot(`req${i}`, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.promise;
        running -= 1;
        return i;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(running).toBe(2);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it("queues past 40 requests per 10 minutes until the window slides", async () => {
    for (let i = 0; i < 40; i++) await mod.withHistorySlot(`r${i}`, async () => i);
    const fn = vi.fn(async () => "late");
    const late = mod.withHistorySlot("r40", fn);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(late).resolves.toBe("late");
  });

  it("opens the circuit after three consecutive timeouts, then allows a probe", async () => {
    const timeout = () => Promise.reject(new mod.IbTimeoutError("h", 1000));
    for (let i = 0; i < 3; i++) {
      await expect(mod.withHistorySlot("h", timeout)).rejects.toBeInstanceOf(mod.IbTimeoutError);
    }
    const fn = vi.fn(async () => "ok");
    await expect(mod.withHistorySlot("h", fn)).rejects.toThrow(/skipped — IB historical data unresponsive/);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(mod.withHistorySlot("h", fn)).resolves.toBe("ok");
    // A success closes the circuit again.
    await expect(mod.withHistorySlot("h", fn)).resolves.toBe("ok");
  });

  it("does not count non-timeout errors toward the circuit", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(mod.withHistorySlot("h", () => Promise.reject(new Error("bad")))).rejects.toThrow("bad");
    }
    await expect(mod.withHistorySlot("h", async () => 1)).resolves.toBe(1);
  });
});
