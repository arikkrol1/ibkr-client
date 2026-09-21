# CLAUDE.md

Guidance for Claude Code in this repo. The full agent guide is in `AGENTS.md`:

@AGENTS.md

## The one rule that's easy to forget

**Any change to the user-facing UI must update `README.md` in the same change.**

If you add/rename a tab, change a view/chart/table, alter a control (timeframe,
filter, toggle, mode), or add/change an env var or run command, update the
matching section of `README.md` (§4 tabs & views, §3 config, §5 API surface)
before considering the task done. See `AGENTS.md` for the full checklist.

This client is **read-only** — never add order-placing capability.
