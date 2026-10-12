# 0008. Retention, storage quota, and hardening

Status: accepted

## Retention

- A scheduled job (`retention.sweep`, every 2 minutes by default, `RETENTION_SWEEP_CRON`) runs through pg-boss, so with several API instances only one sweep runs per tick.
- Each sweep, in order:
  1. Open orders (`pending`, `accepted`, `printing`) past `expires_at` become `expired`; orders stuck in `processing` for `STUCK_PROCESSING_MINUTES` become `failed`. Shops and students are told over the realtime channel.
  2. Uploads past their expiry have their files deleted. Rows that an order points at stay (without file keys); abandoned uploads are deleted entirely.
  3. Finished orders past `expires_at` lose their print PDFs and get `files_purged_at`. The order record (number, name, settings, price, status) stays for history.
  4. The quota rule below.
- A sweep is idempotent and safe to run at any time. Every sweep that did something writes one audit row; every eviction writes one per order.
- The `retention` module owns no tables. It talks to `documents` and `orders` only through narrow ports (`purgeExpired`, `storedUploads`, `purgeUploads`, `retire`, `printFileUsage`, `evictFiles`), so the rules can be unit-tested with fakes.

## Storage quota

- `STORAGE_MAX_BYTES` (5 GB) with a **high watermark** (90%) and a **low watermark** (75%), both configurable. Above the high mark, whole _units_ (an upload together with its order's print files) are removed until usage is under the low mark.
- Order of removal: abandoned uploads and finished orders first, then orders that may still be printed; within each group, oldest first. An open order that has to go becomes `expired` with a clear reason.
- Per-shop quotas and the admin-panel override of the global limit arrive with phase 8; `maxBytes` is already a function so the setting can change without a restart.
- New uploads are still refused up front when the disk is full (existing check), so the sweep is never the only line of defence.

## Hardening

- A ceiling per IP across the whole API (`API_RATE_LIMIT_MAX`) on top of per-endpoint limits. Defaults are generous because many students can share one campus NAT address; Turnstile, not IP limits, is the main bot defence.
- nginx sends a strict Content-Security-Policy, `Referrer-Policy: no-referrer` (the order link is a secret), `X-Frame-Options: DENY`, `nosniff`, a restrictive Permissions-Policy and HSTS.
- Signing out closes that user's live connections immediately.
- Privacy notice at `/privacy`, linked from the student pages.

## Dependency audit

`pnpm audit --prod` findings were all inside Prisma's CLI tooling (Studio, config loading, an unused MySQL driver). `lodash` and `mysql2` are forced to patched versions with `overrides`. One advisory remains (`deepmerge-ts` in Prisma's config loader, which only merges our own config files and is not reachable from requests); fixing it needs a major version jump inside Prisma, so it waits for a Prisma update.

## Not in this phase

- Suspending a shop or removing a member does not yet close their open sockets (phase 8, with the admin panel).
- Database backups and a restore test are phase 9. Files are deliberately not backed up: they are temporary by design.
