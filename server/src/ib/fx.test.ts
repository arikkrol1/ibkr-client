import { beforeEach, describe, expect, it, vi } from "vitest";

const ibMock = vi.hoisted(() => ({ api: { getContractDetails: vi.fn() } }));
vi.mock("./connection.js", () => ({ ib: ibMock }));
vi.mock("./marketData.js", () => ({ getHistory: vi.fn() }));

import { getHistory, type HistoryBar } from "./marketData.js";
import { getFxRates, lookup } from "./fx.js";

const bar = (time: number, close: number): HistoryBar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

describe("lookup", () => {
  const sorted = [bar(100, 1), bar(200, 2), bar(300, 4)];

  it("steps forward from the last close at or before the time", () => {
    const r = lookup(sorted, false);
    expect(r.at(100)).toBe(1);
    expect(r.at(250)).toBe(2);
    expect(r.at(10_000)).toBe(4);
  });

  it("uses the earliest close before the series starts", () => {
    expect(lookup(sorted, false).at(0)).toBe(1);
  });

  it("inverts the quote when asked", () => {
    expect(lookup(sorted, true).at(300)).toBe(0.25);
  });
});

describe("getFxRates", () => {
  beforeEach(() => {
    ibMock.api.getContractDetails.mockReset();
    vi.mocked(getHistory).mockReset();
  });

  it("is the identity for the same currency, without asking IB", async () => {
    const r = await getFxRates("USD", "USD", "1 Y");
    expect(r?.at(0)).toBe(1);
    expect(ibMock.api.getContractDetails).not.toHaveBeenCalled();
  });

  it("uses the pair as requested when IB lists it that way", async () => {
    ibMock.api.getContractDetails.mockResolvedValue([{ contract: { symbol: "EUR", currency: "USD" } }]);
    vi.mocked(getHistory).mockResolvedValue([bar(100, 1.1)]);
    const r = await getFxRates("EUR", "USD", "1 Y");
    expect(r?.at(100)).toBe(1.1);
    const req = vi.mocked(getHistory).mock.calls[0][0];
    expect(req.contract).toMatchObject({ symbol: "EUR", currency: "USD" });
    expect(req).toMatchObject({ barSize: "1 day", duration: "1 Y", useRTH: false, whatToShow: "MIDPOINT" });
  });

  it("inverts when IB resolves the pair in the canonical direction", async () => {
    // Asked for SEK.USD; IB quietly answers with USD.SEK (krona per dollar).
    ibMock.api.getContractDetails.mockResolvedValue([{ contract: { symbol: "USD", currency: "SEK" } }]);
    vi.mocked(getHistory).mockResolvedValue([bar(100, 10)]);
    const r = await getFxRates("SEK", "USD", "1 Y");
    expect(r?.at(100)).toBeCloseTo(0.1);
    expect(vi.mocked(getHistory).mock.calls[0][0].contract).toMatchObject({ symbol: "USD", currency: "SEK" });
  });

  it("returns null when the pair can't be resolved or priced", async () => {
    ibMock.api.getContractDetails.mockResolvedValue([]);
    expect(await getFxRates("XXX", "USD", "1 Y")).toBeNull();

    ibMock.api.getContractDetails.mockResolvedValue([{ contract: { symbol: "GBP", currency: "JPY" } }]);
    expect(await getFxRates("EUR", "USD", "1 Y")).toBeNull();

    ibMock.api.getContractDetails.mockRejectedValue(new Error("boom"));
    expect(await getFxRates("EUR", "USD", "1 Y")).toBeNull();

    ibMock.api.getContractDetails.mockResolvedValue([{ contract: { symbol: "EUR", currency: "USD" } }]);
    vi.mocked(getHistory).mockResolvedValue([]);
    expect(await getFxRates("EUR", "USD", "1 Y")).toBeNull();

    vi.mocked(getHistory).mockRejectedValue(new Error("timeout"));
    expect(await getFxRates("EUR", "USD", "1 Y")).toBeNull();
  });
});
