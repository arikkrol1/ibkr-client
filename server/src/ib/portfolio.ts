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
  tag: string,
): number | undefined {
  const perCurrency = values?.get(tag);
  if (!perCurrency) return undefined;
  // Prefer the account's base-currency summary; else take the first entry.
  const entry = perCurrency.get("USD") ?? [...perCurrency.values()][0];
  const n = entry ? Number(entry.value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function getPortfolio(): Promise<PortfolioSnapshot> {
  const accounts = await ib.api.getManagedAccounts();
  const account = accounts[0] ?? null;

  // reqAccountUpdates: positions (with market value + PnL) AND balance values.
  const update = await firstReady(
    ib.api.getAccountUpdates(account ?? undefined),
    (u) => Boolean(u.all?.value && u.all.value.size > 0),
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
    totalCashValue: numTag(values, "TotalCashValue"),
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
