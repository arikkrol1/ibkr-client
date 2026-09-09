import { Stock, type Contract, type ContractDescription } from "@stoqey/ib";
import { ib } from "./connection.js";

export interface SymbolMatch {
  conId?: number;
  symbol?: string;
  name?: string;
  secType?: string;
  currency?: string;
  primaryExch?: string;
}

/** Free-text symbol lookup via reqMatchingSymbols. */
export async function searchSymbols(query: string): Promise<SymbolMatch[]> {
  const descriptions: ContractDescription[] = await ib.api.getMatchingSymbols(query);
  return descriptions
    .map((d) => d.contract)
    .filter((c): c is Contract => Boolean(c))
    .map((c) => ({
      conId: c.conId,
      symbol: c.symbol,
      name: c.description,
      secType: c.secType,
      currency: c.currency,
      primaryExch: c.primaryExch,
    }));
}

/**
 * Build a resolvable Contract from request params. Prefer a conId (unambiguous);
 * otherwise default to a SMART-routed US stock, which covers the common case.
 */
export function resolveContract(params: {
  conId?: number;
  symbol?: string;
  currency?: string;
  exchange?: string;
}): Contract {
  if (params.conId) {
    return {
      conId: params.conId,
      exchange: params.exchange ?? "SMART",
    };
  }
  if (!params.symbol) {
    throw new Error("Either conId or symbol is required");
  }
  return new Stock(params.symbol, params.exchange ?? "SMART", params.currency ?? "USD");
}
