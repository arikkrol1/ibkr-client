import { firstValueFrom, timeout, filter } from "rxjs";
import type { Observable } from "rxjs";
import { ib } from "./connection.js";

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

function numTag(
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
function sumAbsMarketValue(
  portfolio: ReadonlyMap<string, ReadonlyArray<{ pos?: number; marketValue?: number }>> | undefined,
): number {
  if (!portfolio) return 0;
  let sum = 0;
  for (const list of portfolio.values())
    for (const p of list) if (p.pos) sum += Math.abs(p.marketValue ?? 0);
  return sum;
}

export async function getPortfolio(): Promise<PortfolioSnapshot> {
  const accounts = await ib.api.getManagedAccounts();
  const account = accounts[0] ?? null;

  // reqAccountUpdates: positions (with market value + PnL) AND balance values.
  // Tags stream in incrementally (AccountCode first, NetLiquidation & co. later),
  // so don't settle on the first emission — wait until a real balance tag has
  // landed for the account, otherwise balances come back empty.
  const update = await firstReady(
    ib.api.getAccountUpdates(account ?? undefined),
    (u) => {
      const all = u.all?.value;
      if (!all) return false;
      const vals = account ? all.get(account) : [...all.values()][0];
      // Balances aren't ready until NetLiquidation has streamed in.
      if (!vals?.get("NetLiquidation")) return false;
      // Positions also stream in one row at a time and lag the balance tags.
      // GrossPositionValue is the account's total |market value| of holdings, so
      // wait until the rows we've collected cover it (within a small tolerance
      // for live price drift) — otherwise we'd return a partial position list.
      const gross = numTag(vals, "GrossPositionValue") ?? 0;
      if (gross <= 0) return true; // no holdings — nothing to wait for
      return sumAbsMarketValue(u.all?.portfolio) >= gross * 0.98;
    },
    10_000,
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

  const values = account ? update.all?.value?.get(account) : undefined;
  const balances = {
    netLiquidation: numTag(values, "NetLiquidation"),
    totalCashValue: numTag(values, "TotalCashValue", "CashBalance"),
    buyingPower: numTag(values, "BuyingPower"),
    grossPositionValue: numTag(values, "GrossPositionValue"),
    availableFunds: numTag(values, "AvailableFunds"),
    unrealizedPnL: numTag(values, "UnrealizedPnL"),
    realizedPnL: numTag(values, "RealizedPnL"),
  };

  let dailyPnL: number | undefined;
  if (account) {
    try {
      const pnl = await firstReady(
        ib.api.getPnL(account),
        (p) => p.dailyPnL != null,
        6_000,
      );
      dailyPnL = pnl.dailyPnL;
    } catch {
      // PnL stream may not deliver immediately; balances still returned.
    }
  }

  return { account, balances, dailyPnL, positions };
}
