import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Never touch the real legacy cooldown file next to the server package.
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: vi.fn(() => {
    throw new Error("ENOENT");
  }),
  unlinkSync: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    baseCurrency: "USD",
    flex: { token: "tok", queryIds: ["q1"], refreshHours: 12 },
  },
}));

vi.mock("../storage/storage.js", () => ({ getStorage: vi.fn() }));

import { config } from "../config.js";
import { getStorage } from "../storage/storage.js";
import { SqliteStorage } from "../storage/sqlite.js";
import {
  flexConfigured,
  getFlexTrades,
  importFlexStatement,
  parseAccountDaysXml,
  parseCashTransactionsXml,
  parseFlexStatementXml,
  parseFlexTime,
  reparseArchive,
  tradeKeyOf,
  tradesAsOf,
} from "./flex.js";

const utc = (...args: [number, number, number, number?, number?, number?]) =>
  Date.UTC(args[0], args[1], args[2], args[3] ?? 0, args[4] ?? 0, args[5] ?? 0) / 1000;

const STATEMENT = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="all" type="AF">
  <FlexStatements count="1">
    <FlexStatement accountId="U1" fromDate="20250101" toDate="20250131">
      <EquitySummaryInBase>
        <EquitySummaryByReportDateInBase reportDate="20250102" currency="USD" total="10000" cash="2000" stock="8000"/>
        <EquitySummaryByReportDateInBase reportDate="20250103" currency="USD" total="10100" cash="2000" stock="8100"/>
      </EquitySummaryInBase>
      <ChangeInNAV fromDate="20250101" toDate="20250131" currency="USD" twr="9.9" endingValue="99999"/>
      <ChangeInNAV fromDate="20250103" toDate="20250103" currency="USD" twr="1.0" endingValue="10100"/>
      <ChangeInNAV fromDate="20250106" toDate="20250106" currency="USD" twr="-0.5" endingValue="10050"/>
      <Trades>
        <Trade tradeID="t1" symbol="AAPL" conid="265598" assetCategory="STK" currency="USD" multiplier="1"
               dateTime="20250102;103000" quantity="10" tradePrice="150" ibCommission="-1" buySell="BUY" levelOfDetail="EXECUTION"/>
        <Trade tradeID="t2" symbol="AAPL" conid="265598" assetCategory="STK" currency="USD" multiplier="1"
               dateTime="20250103;150000" quantity="5" tradePrice="160" ibCommission="-1" buySell="SELL" levelOfDetail="EXECUTION"/>
        <Trade tradeID="o1" symbol="AAPL" conid="265598" assetCategory="STK" currency="USD" multiplier="1"
               dateTime="20250102;103000" quantity="10" tradePrice="150" ibCommission="-1" buySell="BUY" levelOfDetail="ORDER"/>
      </Trades>
      <CashTransactions>
        <CashTransaction type="Dividends" symbol="AAPL" conid="265598" currency="USD" fxRateToBase="1"
                         amount="12.5" dateTime="20250115;202000" transactionID="c1" levelOfDetail="DETAIL"/>
        <CashTransaction type="Withholding Tax" symbol="AAPL" currency="USD"
                         amount="-1.88" dateTime="20250115;202000" transactionID="c2" levelOfDetail="DETAIL"/>
        <CashTransaction type="Deposits/Withdrawals" currency="EUR" fxRateToBase="1.1"
                         amount="1000" dateTime="20250110" transactionID="c3" levelOfDetail="DETAIL"/>
        <CashTransaction type="Broker Interest Received" currency="USD"
                         amount="0" dateTime="20250131" transactionID="c4" levelOfDetail="DETAIL"/>
        <CashTransaction type="Dividends" symbol="AAPL" amount="12.5" dateTime="20250115" levelOfDetail="SUMMARY"/>
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;

const PENDING = `<FlexStatementResponse timestamp="x">
  <Status>Warn</Status><ErrorCode>1019</ErrorCode>
  <ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage>
</FlexStatementResponse>`;

const SEND_OK = `<FlexStatementResponse timestamp="x">
  <Status>Success</Status><ReferenceCode>REF1</ReferenceCode>
  <Url>https://flex.example/GetStatement</Url>
</FlexStatementResponse>`;

const SEND_FAIL = `<FlexStatementResponse timestamp="x">
  <Status>Fail</Status><ErrorCode>1020</ErrorCode><ErrorMessage>Invalid request</ErrorMessage>
</FlexStatementResponse>`;

const SEND_LOCKED = `<FlexStatementResponse timestamp="x">
  <Status>Fail</Status><ErrorCode>1025</ErrorCode><ErrorMessage>Too many failed attempts</ErrorMessage>
</FlexStatementResponse>`;

let store: SqliteStorage;

beforeEach(() => {
  store = new SqliteStorage(":memory:");
  vi.mocked(getStorage).mockReturnValue(store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("parseFlexTime", () => {
  it("parses compact, punctuated and date-only formats as UTC", () => {
    expect(parseFlexTime("20250102;103000")).toBe(utc(2025, 0, 2, 10, 30));
    expect(parseFlexTime("2025-01-02;10:30:00")).toBe(utc(2025, 0, 2, 10, 30));
    expect(parseFlexTime("20250102")).toBe(utc(2025, 0, 2));
  });

  it("rejects missing or truncated values", () => {
    expect(parseFlexTime(undefined)).toBeUndefined();
    expect(parseFlexTime("")).toBeUndefined();
    expect(parseFlexTime("2025")).toBeUndefined();
  });
});

describe("parseFlexStatementXml", () => {
  it("keeps execution-level rows only, with signed quantities", () => {
    const trades = parseFlexStatementXml(STATEMENT)!;
    expect(trades).toHaveLength(2);
    expect(trades[0]).toEqual({
      tradeId: "t1",
      symbol: "AAPL",
      conId: 265598,
      secType: "STK",
      currency: "USD",
      multiplier: 1,
      time: utc(2025, 0, 2, 10, 30),
      quantity: 10,
      price: 150,
      commission: -1,
    });
    // buySell=SELL wins over an unsigned quantity.
    expect(trades[1].quantity).toBe(-5);
  });

  it("falls back to all rows when no execution-level detail is present", () => {
    const xml = `<FlexQueryResponse><Trades>
      <Trade symbol="MSFT" dateTime="20250102" quantity="-3" tradePrice="400" transactionID="x9"/>
    </Trades></FlexQueryResponse>`;
    const [t] = parseFlexStatementXml(xml)!;
    expect(t).toMatchObject({
      tradeId: "x9",
      symbol: "MSFT",
      quantity: -3,
      multiplier: 1,
      commission: 0,
      conId: undefined,
    });
  });

  it("drops zero-quantity and malformed rows", () => {
    const xml = `<FlexQueryResponse><Trades>
      <Trade symbol="A" dateTime="20250102" quantity="0" tradePrice="1"/>
      <Trade dateTime="20250102" quantity="1" tradePrice="1"/>
      <Trade symbol="B" quantity="1" tradePrice="1"/>
      <Trade symbol="C" dateTime="20250102" quantity="abc" tradePrice="1"/>
    </Trades></FlexQueryResponse>`;
    expect(parseFlexStatementXml(xml)).toEqual([]);
  });

  it("returns null for the still-generating placeholder", () => {
    expect(parseFlexStatementXml(PENDING)).toBeNull();
  });

  it("throws on other Flex errors", () => {
    expect(() => parseFlexStatementXml(SEND_FAIL)).toThrow(/Invalid request/);
  });
});

describe("tradeKeyOf", () => {
  const base = { symbol: "AAPL", multiplier: 1, time: 100, quantity: 5, price: 10, commission: 0 };
  it("prefers the IBKR trade id", () => {
    expect(tradeKeyOf({ ...base, tradeId: "t1", conId: 1 })).toBe("t1");
  });
  it("falls back to a conId (else symbol) composite", () => {
    expect(tradeKeyOf({ ...base, conId: 1 })).toBe("1|100|5|10");
    expect(tradeKeyOf(base)).toBe("AAPL|100|5|10");
  });
});

describe("parseAccountDaysXml", () => {
  it("merges equity summaries with single-day ChangeInNAV rows", () => {
    expect(parseAccountDaysXml(STATEMENT)).toEqual([
      { date: utc(2025, 0, 2), currency: "USD", nav: 10000, cash: 2000, stock: 8000 },
      { date: utc(2025, 0, 3), currency: "USD", nav: 10100, cash: 2000, stock: 8100, twr: 1 },
      // No equity summary that day — NAV comes from ChangeInNAV's endingValue.
      { date: utc(2025, 0, 6), currency: "USD", nav: 10050, twr: -0.5 },
    ]);
  });

  it("ignores period-aggregate ChangeInNAV rows", () => {
    const xml = `<FlexQueryResponse>
      <ChangeInNAV fromDate="20250101" toDate="20250131" twr="9.9" endingValue="1"/>
    </FlexQueryResponse>`;
    expect(parseAccountDaysXml(xml)).toEqual([]);
  });
});

describe("parseCashTransactionsXml", () => {
  it("keeps DETAIL rows, classifies them, and converts to base currency", () => {
    const rows = parseCashTransactionsXml(STATEMENT);
    expect(rows.map((r) => r.txKey)).toEqual(["c1", "c2", "c3"]);
    expect(rows[0]).toEqual({
      txKey: "c1",
      time: utc(2025, 0, 15, 20, 20),
      type: "Dividends",
      kind: "income",
      symbol: "AAPL",
      conId: 265598,
      currency: "USD",
      amount: 12.5,
    });
    expect(rows[1]).toMatchObject({ kind: "income", amount: -1.88 });
    expect(rows[2].kind).toBe("flow");
    expect(rows[2].amount).toBeCloseTo(1100);
  });

  it("builds a composite key when transactionID is missing", () => {
    const xml = `<FlexQueryResponse>
      <CashTransaction type="Other Fees" amount="-10" dateTime="20250105"/>
    </FlexQueryResponse>`;
    expect(parseCashTransactionsXml(xml)[0].txKey).toBe(`Other Fees|${utc(2025, 0, 5)}|-10|`);
  });
});

describe("importFlexStatement / reparseArchive", () => {
  it("archives the XML and stores trades, account days and income", async () => {
    const result = await importFlexStatement(STATEMENT, "manual");
    expect(result).toEqual({ parsed: 2, inserted: 2, accountDays: 3, cashTransactions: 3 });
    expect(await store.getAllTrades()).toHaveLength(2);
    expect(await store.getFlexStatements()).toHaveLength(1);
    expect(await store.getAccountDays(0)).toHaveLength(3);
  });

  it("is idempotent for overlapping statements", async () => {
    await importFlexStatement(STATEMENT, "a");
    const again = await importFlexStatement(STATEMENT, "b");
    expect(again.inserted).toBe(0);
    expect(again.cashTransactions).toBe(0);
    expect(await store.getAllTrades()).toHaveLength(2);
  });

  it("rejects the pending placeholder", async () => {
    await expect(importFlexStatement(PENDING, "x")).rejects.toThrow(/1019/);
  });

  it("re-parses account sections from archived statements", async () => {
    await store.archiveFlexStatement("q1", STATEMENT);
    expect(await reparseArchive()).toEqual({ statements: 1, accountDays: 3, cashTransactions: 3 });
    expect(await store.getCashTransactions(0)).toHaveLength(3);
  });
});

describe("getFlexTrades", () => {
  const stubFetch = (responder: (url: string) => string) => {
    const fn = vi.fn(async (url: string) => new Response(responder(url)));
    vi.stubGlobal("fetch", fn);
    return fn;
  };
  const happy = (url: string) => (url.includes("SendRequest") ? SEND_OK : STATEMENT);

  it("reports whether Flex is configured", () => {
    expect(flexConfigured()).toBe(true);
    const flex = config.flex as { token: string };
    flex.token = "";
    try {
      expect(flexConfigured()).toBe(false);
    } finally {
      flex.token = "tok";
    }
  });

  it("fetches once, then serves from storage while fresh", async () => {
    const fetch = stubFetch(happy);
    const first = await getFlexTrades();
    expect(first.map((t) => [t.symbol, t.quantity, t.price])).toEqual([
      ["AAPL", 10, 150],
      ["AAPL", -5, 160],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2); // SendRequest + GetStatement
    expect(fetch.mock.calls[0][0]).toContain("t=tok&q=q1&v=3");
    expect(fetch.mock.calls[1][0]).toBe("https://flex.example/GetStatement?q=REF1&t=tok&v=3");

    await getFlexTrades();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await tradesAsOf()).toBeTypeOf("number");
    expect(await store.getFlexStatements()).toHaveLength(1);
  });

  it("polls while the statement is still generating", async () => {
    vi.useFakeTimers();
    let statementCalls = 0;
    stubFetch((url) => {
      if (url.includes("SendRequest")) return SEND_OK;
      return ++statementCalls === 1 ? PENDING : STATEMENT;
    });
    const pending = getFlexTrades();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toHaveLength(2);
    expect(statementCalls).toBe(2);
  });

  it("enforces the minimum gap between fetch cycles on forced refresh", async () => {
    stubFetch(happy);
    await getFlexTrades();
    await expect(getFlexTrades({ force: true })).rejects.toThrow(/rate limit/);
  });

  it("enforces the daily request budget without contacting IBKR", async () => {
    const fetch = stubFetch(happy);
    await store.setMeta("flex_req_day", new Date().toISOString().slice(0, 10));
    await store.setMeta("flex_req_day_count", "20");
    await expect(getFlexTrades()).rejects.toThrow(/daily request budget/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sets a short cooldown after a failure and honours it", async () => {
    const fetch = stubFetch(() => SEND_FAIL);
    await expect(getFlexTrades()).rejects.toThrow(/Invalid request/);
    const cd = JSON.parse((await store.getMeta("flex_cooldown"))!);
    expect(cd.until - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(cd.until - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    fetch.mockClear();
    await expect(getFlexTrades()).rejects.toThrow(/next retry after/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("backs off for hours after an account lockout", async () => {
    stubFetch(() => SEND_LOCKED);
    await expect(getFlexTrades()).rejects.toThrow(/Too many failed attempts/);
    const cd = JSON.parse((await store.getMeta("flex_cooldown"))!);
    expect(cd.until - Date.now()).toBeGreaterThan(2 * 3600_000);
  });

  it("serves stale stored trades when a refresh fails", async () => {
    await store.upsertTrades([
      { tradeKey: "old", symbol: "AAPL", multiplier: 1, time: 1, quantity: 1, price: 1, commission: 0 },
    ]);
    await store.setMeta("flex_last_success", String(Date.now() - 13 * 3600_000));
    stubFetch(() => SEND_FAIL);
    const trades = await getFlexTrades();
    expect(trades).toEqual([
      { symbol: "AAPL", multiplier: 1, time: 1, quantity: 1, price: 1, commission: 0 },
    ]);
  });
});
