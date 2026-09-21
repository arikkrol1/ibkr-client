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
- `pnpm --filter web typecheck` / `pnpm --filter server typecheck` — types only.
