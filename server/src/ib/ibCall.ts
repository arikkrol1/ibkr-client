/**
 * Guard rails for request/response calls into the IB API.
 *
 * Every outbound request is logged before send and after completion (with
 * duration), and rejected after a timeout. IBKR silently stops answering
 * historical-data requests during a pacing lockout — without a timeout the
 * promise never settles and every caller up the stack hangs (the "Computing
 * P&L history…" freeze). The timeout cannot cancel the request on the wire
 * (IBApiNext's promise API has no cancellation); it only unblocks the caller.
 */

export class IbTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}: no response from IB after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "IbTimeoutError";
  }
}

let seq = 0;

export async function ibCall<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const id = ++seq;
  const started = performance.now();
  console.log(`[ib →] #${id} ${label}`);
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IbTimeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
    console.log(`[ib ✓] #${id} ${label} (${Math.round(performance.now() - started)}ms)`);
    return result;
  } catch (err) {
    console.warn(
      `[ib ✗] #${id} ${label} (${Math.round(performance.now() - started)}ms): ` +
        `${err instanceof Error ? err.message : err}`,
    );
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- pacing limiter for historical-data requests ---
//
// IBKR allows roughly 60 historical requests per 10 minutes; past that the
// service silently drops requests until the window clears. Funnel every
// history/head-timestamp request through a sliding-window semaphore with
// headroom so bursts (P&L rebuild + sector grid) queue instead of tripping
// the lockout.

const HIST_MAX_CONCURRENT = 2;
const HIST_WINDOW_MS = 10 * 60_000;
const HIST_WINDOW_MAX = 40;

let running = 0;
const starts: number[] = [];
const pending: Array<() => boolean> = [];
let windowTimer: NodeJS.Timeout | undefined;

function drainPending(): void {
  while (pending.length > 0 && pending[0]()) pending.shift();
  if (pending.length === 0 || running >= HIST_MAX_CONCURRENT) return;
  // Blocked on the sliding window — wake when the oldest request expires.
  const waitMs = Math.max(starts[0] + HIST_WINDOW_MS - Date.now(), 50);
  clearTimeout(windowTimer);
  windowTimer = setTimeout(drainPending, waitMs);
}

function acquireHistorySlot(label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const queuedAt = Date.now();
    pending.push(() => {
      // Flush queued waiters as soon as the circuit opens — they'd only be
      // sent to an IB that isn't answering.
      if (historyCircuitOpen()) {
        reject(circuitOpenError(label));
        return true;
      }
      const now = Date.now();
      while (starts.length > 0 && now - starts[0] > HIST_WINDOW_MS) starts.shift();
      if (running >= HIST_MAX_CONCURRENT || starts.length >= HIST_WINDOW_MAX) {
        return false;
      }
      running += 1;
      starts.push(now);
      const waitedMs = now - queuedAt;
      if (waitedMs > 1_000) {
        console.log(`[ib] pacing: ${label} waited ${Math.round(waitedMs / 1000)}s for a slot`);
      }
      resolve();
      return true;
    });
    if (pending.length === 1 && starts.length >= HIST_WINDOW_MAX) {
      const waitMs = starts[0] + HIST_WINDOW_MS - Date.now();
      console.warn(
        `[ib] pacing window full (${HIST_WINDOW_MAX} req/${HIST_WINDOW_MS / 60_000}min) — ` +
          `${label} queued ~${Math.max(Math.ceil(waitMs / 1000), 1)}s`,
      );
    }
    drainPending();
  });
}

// Circuit breaker: when IB's historical-data farm goes silent (pacing
// lockout, farm outage), every request eats its full timeout. After a few
// consecutive timeouts, fail fast for a cool-off so callers fall back to
// stored bars immediately; one probe is allowed after the cool-off.

const CIRCUIT_OPEN_AFTER = 3;
const CIRCUIT_COOLOFF_MS = 60_000;
let consecutiveTimeouts = 0;
let lastTimeoutAt = 0;

function historyCircuitOpen(): boolean {
  return (
    consecutiveTimeouts >= CIRCUIT_OPEN_AFTER &&
    Date.now() - lastTimeoutAt < CIRCUIT_COOLOFF_MS
  );
}

function circuitOpenError(label: string): Error {
  const retryIn = Math.ceil((CIRCUIT_COOLOFF_MS - (Date.now() - lastTimeoutAt)) / 1000);
  return new Error(
    `${label}: skipped — IB historical data unresponsive (retrying in ~${retryIn}s)`,
  );
}

/** Run a historical-data request under the pacing limiter + circuit breaker. */
export async function withHistorySlot<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (historyCircuitOpen()) throw circuitOpenError(label);
  await acquireHistorySlot(label);
  try {
    // Re-check: the circuit may have opened while this request was queued
    // for a slot — sending now would burn another full timeout on dead IB.
    if (historyCircuitOpen()) throw circuitOpenError(label);
    const result = await fn();
    if (consecutiveTimeouts >= CIRCUIT_OPEN_AFTER) {
      console.log("[ib] historical data responding again — circuit closed");
    }
    consecutiveTimeouts = 0;
    return result;
  } catch (err) {
    if (err instanceof IbTimeoutError) {
      consecutiveTimeouts += 1;
      lastTimeoutAt = Date.now();
      if (consecutiveTimeouts === CIRCUIT_OPEN_AFTER) {
        console.warn(
          `[ib] ${CIRCUIT_OPEN_AFTER} consecutive history timeouts — ` +
            `failing fast for ${CIRCUIT_COOLOFF_MS / 1000}s (stored bars serve as fallback)`,
        );
      }
    }
    throw err;
  } finally {
    running -= 1;
    drainPending();
  }
}
