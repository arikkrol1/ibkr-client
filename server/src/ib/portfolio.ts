import { firstValueFrom, timeout, filter, debounceTime, merge, tap, share, of, throwError } from "rxjs";
import type { Observable } from "rxjs";
import { ib } from "./connection.js";
import { ibCall } from "./ibCall.js";

export interface PortfolioPosition {
  conId?: number;
  symbol?: string;
  secType?: string;
  currency?: string;
  position: number;
  avgCost?: number;
  marketPrice?: number;
  marketValue?: number;
  unrealizedPnL?: number;
  realizedPnL?: number;
}

export interface PortfolioSnapshot {
  account: string | null;
  balances: {
    netLiquidation?: number;
    totalCashValue?: number;
    buyingPower?: number;
    grossPositionValue?: number;
    availableFunds?: number;
    unrealizedPnL?: number;
    realizedPnL?: number;
  };
  dailyPnL?: number;
  positions: PortfolioPosition[];
}

/**
 * Resolve the latest value from a continuously-updating observable: wait for the
 * first meaningful emission (with a timeout), giving TWS a beat to populate.
 */
function firstReady<T>(obs: Observable<T>, ready: (v: T) => boolean, ms: number): Promise<T> {
  return firstValueFrom(obs.pipe(filter(ready), timeout({ first: ms })));
}

/**
 * Settle a continuously-updating snapshot once it's actually complete.
 *
 * reqAccountUpdates streams position rows one at a time, so we can't trust the
 * first emission that merely *has* balances — small positions arrive last and
 * would be dropped. We settle on the first emission that's provably complete
 * (`complete`), and otherwise fall back to the last emission after the stream
 * goes quiet for `quietMs` (the download burst has finished). `maxMs` caps the
 * wait and, on timeout, returns the latest emission we saw rather than throwing.
 */
export function settleWhenComplete<T>(
  obs: Observable<T>,
  gate: (v: T) => boolean,
  complete: (v: T) => boolean,
  quietMs: number,
  maxMs: number,
): Promise<T> {
  let last: T | undefined;
  const gated = obs.pipe(filter(gate), tap((v) => (last = v)), share());
  const settled = merge(
    gated.pipe(filter(complete)), // fast path: the list already covers the account
    gated.pipe(debounceTime(quietMs)), // safety net: stream has stopped growing
  );
  return firstValueFrom(
    settled.pipe(
      timeout({
        first: maxMs,
        with: () =>
          last !== undefined
            ? of(last)
            : throwError(() => new Error("Timed out waiting for account updates")),
      }),
    ),
  );
}

export function numTag(
  values: ReadonlyMap<string, ReadonlyMap<string, { value: string }>> | undefined,
  ...tags: string[]
): number | undefined {
  // Accept multiple candidate tag names (reqAccountUpdates tag names vary by
  // account, e.g. cash is "CashBalance" rather than "TotalCashValue").
  let perCurrency: ReadonlyMap<string, { value: string }> | undefined;
  for (const tag of tags) {
    perCurrency = values?.get(tag);
    if (perCurrency) break;
  }
  if (!perCurrency) return undefined;
  // Prefer the consolidated base-currency value ("BASE"), which sums all legs of
  // a multi-currency account; else USD; else the first entry.
  const entry =
    perCurrency.get("BASE") ?? perCurrency.get("USD") ?? [...perCurrency.values()][0];
  const n = entry ? Number(entry.value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Sum of absolute market values across non-zero position rows. */
export function sumAbsMarketValue(
  portfolio: ReadonlyMap<string, ReadonlyArray<{ pos?: number; marketValue?: number }>> | undefined,
): number {
  if (!portfolio) return 0;
  let sum = 0;
  for (const list of portfolio.values())
    for (const p of list) if (p.pos) sum += Math.abs(p.marketValue ?? 0);
  return sum;
}

export async function getPortfolio(): Promise<PortfolioSnapshot> {
  const accounts = await ibCall("getManagedAccounts", 10_000, () =>
    ib.api.getManagedAccounts(),
  );
  const account = accounts[0] ?? null;

  // reqAccountUpdates: positions (with market value + PnL) AND balance values.
  // Tags stream in incrementally (AccountCode first, NetLiquidation & co. later),
  // so don't settle on the first emission — wait until a real balance tag has
  // landed for the account, otherwise balances come back empty.
  const update = await ibCall(`getAccountUpdates ${account ?? "default"}`, 12_000, () =>
    settleWhenComplete(
      ib.api.getAccountUpdates(account ?? undefined),
      // Balances aren't ready until NetLiquidation has streamed in.
      (u) => {
        const all = u.all?.value;
        if (!all) return false;
        const vals = account ? all.get(account) : [...all.values()][0];
        return Boolean(vals?.get("NetLiquidation"));
      },
      // Complete once the collected rows account for essentially all of
      // GrossPositionValue (the account's total |market value| of holdings).
      // Positions stream in one row at a time and lag the balance tags, so a
      // loose threshold would drop the smallest holdings before they arrive.
      (u) => {
        const all = u.all?.value;
        const vals = account ? all?.get(account) : all ? [...all.values()][0] : undefined;
        const gross = numTag(vals, "GrossPositionValue") ?? 0;
        if (gross <= 0) return true; // no holdings — nothing to wait for
        return sumAbsMarketValue(u.all?.portfolio) >= gross * 0.999;
      },
      600, // quiet window: the initial download burst has finished
      10_000,
    ),
  );

  const positions: PortfolioPosition[] = [];
  const portfolioMap = update.all?.portfolio;
  if (portfolioMap) {
    for (const list of portfolioMap.values()) {
      for (const p of list) {
        if (!p.pos) continue; // skip closed/zero positions
        positions.push({
          conId: p.contract.conId,
          symbol: p.contract.symbol,
          secType: p.contract.secType,
          currency: p.contract.currency,
          position: p.pos,
          avgCost: p.avgCost,
          marketPrice: p.marketPrice,
          marketValue: p.marketValue,
          unrealizedPnL: p.unrealizedPNL,
          realizedPnL: p.realizedPNL,
        });
      }
    }
  }
  positions.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));

  // Fall back to the sum of per-position P&L when the account-level tag isn't
  // delivered by reqAccountUpdates (some accounts omit UnrealizedPnL/RealizedPnL,
  // even though every position row carries its own value).
  const sumPositionPnL = (key: "unrealizedPnL" | "realizedPnL"): number | undefined => {
    const vals = positions.map((p) => p[key]).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
  };

  const values = account ? update.all?.value?.get(account) : undefined;
  const balances = {
    netLiquidation: numTag(values, "NetLiquidation"),
    totalCashValue: numTag(values, "TotalCashValue", "CashBalance"),
    buyingPower: numTag(values, "BuyingPower"),
    grossPositionValue: numTag(values, "GrossPositionValue"),
    availableFunds: numTag(values, "AvailableFunds"),
    unrealizedPnL: numTag(values, "UnrealizedPnL") ?? sumPositionPnL("unrealizedPnL"),
    realizedPnL: numTag(values, "RealizedPnL") ?? sumPositionPnL("realizedPnL"),
  };

  let dailyPnL: number | undefined;
  if (account) {
    try {
      const pnl = await ibCall(`getPnL ${account}`, 8_000, () =>
        firstReady(
          ib.api.getPnL(account),
          (p) => p.dailyPnL != null,
          6_000,
        ),
      );
      dailyPnL = pnl.dailyPnL;
    } catch {
      // PnL stream may not deliver immediately; balances still returned.
    }
  }

  return { account, balances, dailyPnL, positions };
}
