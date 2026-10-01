# Screenshots

These images are used in the top-level [`README.md`](../../README.md).

**All data shown is synthetic** — a fake demo account (`DU1234567`) with
made-up positions and randomly generated price history. No real account data
appears in any screenshot.

To refresh them after a UI change, run the app against a backend serving demo
data (e.g. a local mock that implements the `/api/*` + `/ws/quotes` surface
documented in the root README) and capture each tab at ~1360px wide:

- `dashboard.png` — `/`
- `pnl.png` — `/pnl`
- `activity.png` — `/activity` (not captured yet)
- `compare.png` — `/compare` (with the holdings added to the chart)
- `charts.png` — `/chart` (with a symbol selected, e.g. AAPL)
- `sectors.png` — `/sectors`
