# Copilot Workspace Rules — BG Tracker

## 🚨 ABSOLUTE RULES — NEVER VIOLATE 🚨
## Error Handling Philosophy: Fail Loud, Never Fake

Prefer a visible failure over a silent fallback.

- Never silently swallow errors to keep things "working."
  Surface the error. Don't substitute placeholder data.
- Fallbacks are acceptable only when disclosed. Show a
  banner, log a warning, annotate the output.
- Design for debuggability, not cosmetic stability.

Priority order:
1. Works correctly with real data
2. Falls back visibly — clearly signals degraded mode
3. Fails with a clear error message
4. Silently degrades to look "fine" — never do this

### NEVER reset, drop, or destroy the database without EXPLICIT user permission.
- Do NOT run `docker compose down -v`
- Do NOT run `rm -rf data/postgres`
- Do NOT drop or recreate the database
- Do NOT run any command that destroys data
- If a schema change is needed, use `upgrade.sql` or run ALTER/CREATE OR REPLACE statements directly
- ALWAYS ask for permission before ANY destructive database operation
- There is NO exception to this rule

### Formatting and rounding is a UI concern, not a DB concern.
- Store full precision in the database
- Round/format numbers in the frontend only (e.g. `formatCurrency()`)
- Do NOT add ROUND() to SQL views or queries
- Do NOT modify stored values for display purposes

### Always back up before destructive operations.
- If the user explicitly grants permission for a destructive operation, take a backup FIRST
- Use `pg_dump` before any schema migration that alters or drops objects

