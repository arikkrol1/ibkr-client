import { beforeEach, describe, expect, it, vi } from "vitest";

const ibMock = vi.hoisted(() => ({
  api: { getMatchingSymbols: vi.fn(), getContractDetails: vi.fn() },
}));
vi.mock("./connection.js", () => ({ ib: ibMock }));
vi.mock("../storage/storage.js", () => ({ getStorage: vi.fn() }));

import { getStorage } from "../storage/storage.js";
import { SqliteStorage } from "../storage/sqlite.js";
import { getSymbolInfo, resolveContract, searchSymbols } from "./contracts.js";

beforeEach(() => {
  vi.mocked(getStorage).mockReturnValue(new SqliteStorage(":memory:"));
  ibMock.api.getMatchingSymbols.mockReset();
  ibMock.api.getContractDetails.mockReset();
});

describe("resolveContract", () => {
  it("prefers the conId", () => {
    expect(resolveContract({ conId: 42, symbol: "AAPL" })).toEqual({ conId: 42, exchange: "SMART" });
    expect(resolveContract({ conId: 42, exchange: "NASDAQ" })).toEqual({ conId: 42, exchange: "NASDAQ" });
  });

  it("defaults a bare symbol to a SMART-routed USD stock", () => {
    expect(resolveContract({ symbol: "AAPL" })).toMatchObject({
      symbol: "AAPL",
      secType: "STK",
      exchange: "SMART",
      currency: "USD",
    });
    expect(resolveContract({ symbol: "VOLV B", currency: "SEK" })).toMatchObject({ currency: "SEK" });
  });

  it("requires a conId or symbol", () => {
    expect(() => resolveContract({})).toThrow(/conId or symbol/);
  });
});

describe("searchSymbols", () => {
  it("maps contract descriptions and drops empty ones", async () => {
    ibMock.api.getMatchingSymbols.mockResolvedValue([
      {
        contract: {
          conId: 1,
          symbol: "AAPL",
          description: "APPLE INC",
          secType: "STK",
          currency: "USD",
          primaryExch: "NASDAQ",
        },
      },
      {},
    ]);
    expect(await searchSymbols("aapl")).toEqual([
      { conId: 1, symbol: "AAPL", name: "APPLE INC", secType: "STK", currency: "USD", primaryExch: "NASDAQ" },
    ]);
    expect(ibMock.api.getMatchingSymbols).toHaveBeenCalledWith("aapl");
  });
});

describe("getSymbolInfo", () => {
  const details = [
    {
      contract: { conId: 1, symbol: "AAPL", secType: "STK", currency: "USD", primaryExch: "NASDAQ" },
      longName: "APPLE INC",
      stockType: "COMMON",
      industry: "Technology",
      category: "Computers",
      subcategory: "Computers",
    },
  ];

  it("fetches contract details once, then serves them from storage", async () => {
    ibMock.api.getContractDetails.mockResolvedValue(details);
    const info = await getSymbolInfo({ conId: 1 });
    expect(info).toEqual({
      conId: 1,
      symbol: "AAPL",
      longName: "APPLE INC",
      secType: "STK",
      stockType: "COMMON",
      industry: "Technology",
      category: "Computers",
      subcategory: "Computers",
      currency: "USD",
      primaryExch: "NASDAQ",
    });
    expect(await getSymbolInfo({ conId: 1 })).toEqual(info);
    expect(ibMock.api.getContractDetails).toHaveBeenCalledTimes(1);
  });

  it("throws when IB knows no such contract", async () => {
    ibMock.api.getContractDetails.mockResolvedValue([]);
    await expect(getSymbolInfo({ symbol: "NOPE" })).rejects.toThrow(/No contract details/);
  });
});
