import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { importFlexStatement } from "../ib/flex.js";
import { getStorage } from "../storage/storage.js";

/**
 * Backfill trade history from manually downloaded Flex statement XMLs.
 *
 * The Flex web service only reaches 365 days back, but in Client Portal
 * (Performance & Reports → Flex Queries) the same query can be RUN with a
 * custom date range going back to account inception (≤365 days per run).
 * Download each period as XML, then:
 *
 *   pnpm --filter server import:flex ~/Downloads/2021.xml ~/Downloads/2022.xml …
 *
 * Safe to re-run: trades dedup on tradeKey. The running server picks the new
 * trades up within its 60s P&L response cache (no restart needed).
 */

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: pnpm --filter server import:flex <statement.xml> [more.xml …]");
  process.exit(1);
}

for (const file of files) {
  const xml = readFileSync(file, "utf8");
  const { parsed, inserted } = await importFlexStatement(xml, `manual:${basename(file)}`);
  console.log(`${file}: ${parsed} trades in statement, ${inserted} new`);
  if (parsed === 0) {
    console.warn(
      `  warning: no <Trade> rows found — check the query includes the Trades section`,
    );
  }
}

const all = await getStorage().getAllTrades();
if (all.length > 0) {
  const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(
    `store now holds ${all.length} trades, ${day(all[0].time)} → ${day(all[all.length - 1].time)}`,
  );
}
await getStorage().close();
