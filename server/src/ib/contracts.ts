import { Stock, type Contract, type ContractDescription } from "@stoqey/ib";
import { ib } from "./connection.js";
import { getStorage } from "../storage/storage.js";

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

export interface SymbolInfo {
  conId?: number;
  symbol?: string;
  longName?: string;
  secType?: string;
  /** IBKR stock classification, e.g. "COMMON", "ETF", "ETN", "ADR". */
  stockType?: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  currency?: string;
  primaryExch?: string;
}

/**
 * Descriptive contract details (name, industry classification, asset type).
 * Immutable in practice, so cached forever in storage meta.
 */
export async function getSymbolInfo(params: {
  conId?: number;
  symbol?: string;
}): Promise<SymbolInfo> {
  const contract = resolveContract(params);
  const store = getStorage();
  const cacheKey = `symbol_info:${
    contract.conId ?? `${contract.symbol}:${contract.currency}:${contract.exchange}`
  }`;
  const cached = await store.getMeta(cacheKey);
  if (cached) return JSON.parse(cached) as SymbolInfo;

  const details = await ib.api.getContractDetails(contract);
  const d = details[0];
  if (!d) throw new Error("No contract details found");
  const info: SymbolInfo = {
    conId: d.contract?.conId,
    symbol: d.contract?.symbol,
    longName: d.longName,
    secType: d.contract?.secType,
    stockType: d.stockType,
    industry: d.industry,
    category: d.category,
    subcategory: d.subcategory,
    currency: d.contract?.currency,
    primaryExch: d.contract?.primaryExch,
  };
  await store.setMeta(cacheKey, JSON.stringify(info));
  return info;
}
