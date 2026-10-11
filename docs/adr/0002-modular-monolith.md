# ADR 0002: Modular monolith with enforced boundaries

Status: accepted (2026-10-11)

## Rules (enforced by `pnpm boundaries`, see `.dependency-cruiser.cjs`)

1. A module under `apps/api/src/modules/<name>` may import another module only through that module's `index.ts`.
2. `apps/api/src/platform/*` (db, storage, queue, realtime, http, observability) never imports from `modules/`.
3. `packages/*` never import from `apps/*`; `packages/domain` stays pure (no I/O, no frameworks).
4. No circular dependencies.
5. `process.env` is read only in `@print/config` (ESLint rule).
6. Every table that belongs to a shop carries `shop_id`, and every repository query on it is scoped by shop.

## Module layout

```
modules/<name>/
  http/      routes + controllers (thin)
  service/   use-cases
  repo/      the only code that talks to the database for this module
  events.ts  domain events published/consumed
  index.ts   the module's public API
```
