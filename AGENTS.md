# Agent guide

Guidance for AI coding agents (Claude Code, Codex, etc.) working in this repo.

## Keep the docs in lockstep with the UI

**Any change to the user-facing UI must update `README.md` in the same change.**

This applies whenever you:

- add, remove, or rename a **tab** (`web/src/App.tsx` + `web/src/pages/*`);
- add, remove, or restructure a **view/section, chart, table, or card** within a
  tab;
- change **user-facing controls** — timeframe/range presets, filters, toggles,
  modes, or the curated symbol/sector universes;
- change **quote/price badges** or other visible states (e.g. the DELAYED badge);
- add or change an **environment variable**, run command, or the setup/prereq
  steps.

Update the matching part of `README.md`:

- **§4 "The UI — tabs & views"** — the source of truth for what each tab shows.
- **§3 Configuration** — the env-var table.
- **§5 API surface** — when routes change (`server/src/routes/*`).
- **Prerequisites / §1–2** — when setup or run steps change.
- **`docs/screenshots/`** — when a tab's appearance changes noticeably, refresh
  its screenshot (synthetic demo data only — never a real account). See
  `docs/screenshots/README.md`.

Treat a UI change with no README update as incomplete. If a change makes a
screenshot or description in the README wrong, fix it in the same commit.

## Keep unit tests in lockstep with the code

**Any change to behaviour must add or update unit tests in the same change.**

- Tests are Vitest, colocated with the module as `*.test.ts`
  (`server/src/**`, `web/src/**`).
- New logic gets tests; changed logic gets its tests updated; a bug fix gets a
  test that fails without the fix. Pure refactors must keep existing tests
  green without weakening them.
- Keep logic testable: put pure computation in plain `.ts` modules (e.g.
  `web/src/utils/`, exported helpers in `server/src/ib/`) rather than inside
  React components, and test it there.
- Server tests mock the IB connection (`vi.mock("./connection.js")`) and use
  `new SqliteStorage(":memory:")` — never a real account, the real
  `.data/ibkr.sqlite`, real Flex credentials, or network calls.
- Test data is synthetic only — never paste real account data into fixtures.
- Run `pnpm test` (and the typecheck commands) before considering a task done;
  don't delete, skip, or loosen a failing test to make it pass — fix the code,
  or explain why the test's expectation was wrong.

Treat a behaviour change with no test change as incomplete.

## Scope guardrail

This client is **read-only** — it must never place, modify, or cancel orders.
Reject or flag any change that would introduce order-placement capability.

## Project layout

- `server/` — Fastify backend (IB connection, market data, portfolio, P&L, Flex
  import). Routes in `server/src/routes/`.
- `web/` — React + Vite frontend. One page component per tab in `web/src/pages/`.

## Commands

- `pnpm dev` — run backend + frontend with hot reload.
- `pnpm build` — typecheck + build both packages.
- `pnpm --filter web typecheck` / `pnpm --filter server typecheck` — types only
  (the server's also typechecks its tests).
- `pnpm test` — run all unit tests (Vitest) in both packages.
- `pnpm --filter server test:watch` / `pnpm --filter web test:watch` — watch mode.
