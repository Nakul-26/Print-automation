# Print Shop Order Platform: Analysis and Development Plan (v2)

v2 changes: full multi-shop scope from the start, Socket.IO from the start, a print-agent solution for colour and duplex, configurable Office-to-PDF conversion with preview, 1-day retention with quota eviction, and a strictly modular architecture.

## 1. Idea in one paragraph

Print shops near schools and colleges lose time and money handling print jobs sent over WhatsApp or email. Students instead scan a shop's QR code, upload a document, set print options, see a price estimate, and get a queue number (optional name). The owner sees a live queue, accepts or rejects orders, calls the number, takes payment at the counter, and prints with one click. No online payment in v1.

## 2. Decisions

| Topic               | Decision                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shops               | Multi-tenant from day one: every row is scoped by `shop_id`; admin panel and approval-based onboarding included                                                                                                                                        |
| Storage             | Own server, persistent Docker volume, behind a `StorageDriver` interface (S3/R2 can be added later)                                                                                                                                                    |
| Retention           | Files kept **1 day from order creation**, then deleted. If storage crosses a limit, delete the oldest files first (see 7)                                                                                                                              |
| Storage limit       | **5 GB total to start**, easy to change: `STORAGE_MAX_BYTES` env var is the default, and the platform admin can change the global and per-shop limits from the admin panel without a redeploy (stored in a `platform_settings` table, values in bytes) |
| Shop printers       | Pilot shop has **one B&W printer and one colour printer**. Colour mode picks the printer, so the owner never chooses. Mapping is stored per shop in `shop_printers`                                                                                    |
| Owner workflow goal | **Owner only clicks Print or Reject.** Everything else (printer, colour, sides, copies, page range, paper size) is applied automatically by the print agent                                                                                            |
| Pricing             | Server-calculated estimate from each shop's rates; owner may adjust the final amount                                                                                                                                                                   |
| Customer identity   | Queue number + optional name; unguessable lookup token for status                                                                                                                                                                                      |
| File formats        | PDF, JPG/PNG first-class. DOCX/PPTX/XLSX via LibreOffice with student-controlled settings and mandatory preview                                                                                                                                        |
| Database            | PostgreSQL                                                                                                                                                                                                                                             |
| ORM                 | **Prisma (decided)**, see section 11                                                                                                                                                                                                                   |
| Real-time           | Socket.IO from the start, behind a `RealtimeGateway` interface                                                                                                                                                                                         |
| Colour / duplex     | Baked into the PDF where possible, plus a local print agent for exact printer settings (see 4)                                                                                                                                                         |
| Deployment          | Docker + Dokploy, Traefik proxy handles HTTPS and WebSockets                                                                                                                                                                                           |

## 3. Analysis summary

**Strengths:** narrow, real pain point; no signup for students; payment and printer integration deliberately out of v1; the relational model fits PostgreSQL; security basics (private files, shop-scoped queries, server-side pricing) are already planned.

**Main risks and how this plan handles them**

| Risk                                                               | Mitigation                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner must set colour/duplex manually, so time is still wasted     | Layered solution in section 4: grayscale baked into the PDF, printer presets, and a print agent that applies exact settings                          |
| Office conversion changes pagination, so price and print are wrong | Student-controlled conversion settings + live preview + "confirm what will print" step; page count and price come from the converted PDF (section 5) |
| Public upload endpoint abuse (malware, spam, disk fill)            | Rate limits, Turnstile, content sniffing, sandboxed conversion with limits, per-shop and global quotas                                               |
| Sensitive student documents                                        | 1-day retention, authenticated downloads only, audit log, privacy notice, backups that respect retention                                             |
| No-shows                                                           | Orders auto-expire; files deleted regardless                                                                                                         |
| Single server is a single point of failure                         | Off-server encrypted backups with a tested restore before the pilot                                                                                  |
| Estimate differs from the real price                               | Labelled as an estimate; owner can set the final amount at completion                                                                                |
| Code becoming tangled over years                                   | Enforced module boundaries, ports and adapters, and tests (section 9)                                                                                |

## 4. Colour, duplex, and getting the settings right without extra owner work

**Why printing from the browser works today:** when the owner opens a PDF in Chrome and presses Print, Chrome shows the operating system's print dialog, where the owner types the pages, copies, colour or B&W, and 2-sided, and picks the printer (this shop has one B&W and one colour printer). The settings are applied by **the owner, by hand, every time**. A website cannot pre-fill that dialog or press the button silently, which is exactly the work this product must remove.

**Goal:** the owner clicks only **Print** or **Reject**. The student already chose the settings, so the system must apply them automatically. That needs something on the shop PC that is allowed to print silently: the **print agent (Layer 2 below)**. It is therefore a **core feature built before the pilot**, not an add-on. With two printers, "B&W vs colour" simply means "send to the B&W printer or the colour printer", which makes it simple and reliable.

The student chooses colour or B&W, sides, copies, and so on. The shop's printer then honours those choices through four layers:

**Layer 1: Bake into the file (server, always on)**

- Page range and pages-per-sheet (n-up) are applied to the print PDF (`qpdf`/`pdf-lib`).
- **B&W jobs are converted to true grayscale** with Ghostscript (`-sColorConversionStrategy=Gray`), so a B&W order can never print colour pages.
- Paper size is normalised where requested.
- Caveat: some colour printers still use colour toner for gray, so set the printer's default to "grayscale/black only" for B&W presets.

**Layer 2: Print agent (recommended, long-term solution)**

- A small app on the shop's PC (Node CLI or tray app) signs in with a device token and connects to the API over an outbound WebSocket (no open ports at the shop).
- The owner clicks **Print** in the dashboard (after payment). The agent downloads the print PDF and prints silently with the exact settings:
  - Windows: SumatraPDF, e.g. `-print-to "<printer>" -print-settings "duplexlong,monochrome,2x,paper=A4"`.
  - Linux/macOS: CUPS, e.g. `lp -n 2 -o sides=two-sided-long-edge -o print-color-mode=monochrome -o media=A4`.
- Reports success or failure back to the dashboard. If the agent is offline, the dashboard falls back to download + manual print.
- **Printer routing:** the shop's settings map each colour mode to a physical printer (B&W → the B&W printer, Colour → the colour printer). The agent lists the printers installed on the PC so the admin can pick them once during setup.
- **Owner flow:** order arrives → owner clicks Print → agent prints → order is marked completed (or "print failed, retry"). Reject is one click. Payment is collected at the counter; no extra step in the app.
- Agents are first-class clients in the API (device tokens, per-shop, revocable). Built in phase 7, before the pilot.
- **Easy setup with no Windows warning (a few steps):** the agent is distributed through the **Microsoft Store** (packaged as MSIX), so Windows trusts it and shows no "Windows protected your PC" screen, and no code-signing certificate is needed.
  1. In the dashboard, owner clicks **"Set up printing"**. The page shows a **Install from Microsoft Store** button and a 6-digit **pairing code** (valid 15 minutes, single-use).
  2. The Store opens; owner clicks **Get/Install**, then **Open**.
  3. Owner types the 6-digit code into the agent (the only manual input).
  - After pairing, the agent discovers the installed printers (Windows `Get-Printer` + print capabilities), **auto-detects colour vs B&W and duplex support**, and assigns the B&W and colour printers. The dashboard turns to **"Printing connected ✓"** and shows the detected mapping; the owner only has to act if detection is ambiguous (for example two colour printers), in which case it is a single dropdown.
  - A **"Send test page"** button in the dashboard confirms the setup end to end.
- **Technology:** Electron tray app with SumatraPDF bundled inside, so there is nothing else to install. It is packaged as **MSIX** with `electron-builder` and published to the Microsoft Store; the Store also handles **automatic updates** on the shop PC. A Tauri/Node-service build can replace it later behind the same agent protocol.
- **Store requirements:** a one-time Microsoft Partner Center developer account (individual accounts have a small one-time fee, roughly US$19; verify current price and India availability), an app name, a privacy policy URL, and Microsoft's certification review for each release (usually a few days). **Start the account registration early**, since identity verification can take time. The pilot does not wait for it (see the two distribution tracks below).
- **Reliability:** runs in the tray, reconnects automatically, retries failed jobs, and shows "agent offline" in the dashboard within seconds. Print jobs are only fetched over an outbound HTTPS/WebSocket connection (no ports opened at the shop).
- **Two distribution tracks (so the Store account never blocks the pilot):**
  - **Track A, Microsoft Store (target):** no warning, automatic updates. You and your friends set up the Partner Center account in parallel; it can take time and does not block development.
  - **Track B, manual installer (fallback, used first if the Store isn't ready):** a normal downloaded installer (`.exe`). Windows shows the "Windows protected your PC" warning once; the installer is installed by us on the shop PC (or the owner clicks **More info → Run anyway**). Same agent code, same 6-digit pairing code, same features. Auto-update uses our own server in this track.
  - The agent's build scripts produce both packages (MSIX for the Store, installer for manual use), so switching to the Store later needs no code changes and existing shops can be migrated.
- **Why not a downloaded .exe as the main route:** an installer downloaded from our website without a trusted code-signing certificate shows the SmartScreen warning ("Windows protected your PC"). Store distribution avoids it entirely. Fallbacks, in order: (a) a cloud code-signing service such as Microsoft's Trusted Signing, if available for your country; (b) a standard code-signing certificate (paid yearly; SmartScreen reputation can take a while to build); (c) during the pilot only, you install the agent yourself on the shop PC, so the owner never sees a warning.
- **Distribution is isolated** behind the build scripts (`apps/agent`), so the same agent code can ship through the Store, a signed installer, or both.
- **Can't we skip the agent entirely?** No browser-only way exists to print silently with chosen printer, colour, and duplex. The nearest option (Chrome launched with `--kiosk-printing`) prints instantly but only to the default printer with default settings, so it cannot honour the student's choices. The agent is the only route to "owner clicks Print and nothing else".

**Layer 3: Manual fallback (if the agent is offline or not yet installed)**

- The dashboard shows which printer to use (B&W or colour) and big chips for sides and copies, with a download/open-PDF button, so the owner can print through the browser as they do today.

**Layer 4: Clear instructions in the UI**

- Each order card shows big chips: B&W / Colour, 1-side / 2-side, copies, paper, and the target printer.

Order of delivery: Layers 1, 3 and 4 in the core build; Layer 2 (agent) in phase 7, before the pilot.

## 5. Office files: conversion with student control and preview

Flow:

1. Student uploads DOCX / PPTX / XLSX (and ODT/ODP/ODS, CSV optionally).
2. Server converts with LibreOffice headless in a sandboxed worker (timeout, memory limit, no network).
3. The student sees the converted PDF in an in-browser preview (pdf.js), with the page count.
4. The student can change **conversion settings**; each change re-runs the conversion (debounced, shown as "updating preview...") and refreshes the preview.
5. The student must press **"This looks right"** before they can continue. Page count and price come from this converted PDF.

Conversion settings by type:

| Type             | Settings                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Common           | Paper size (A4/A3), orientation (auto/portrait/landscape), margins (default/narrow/none)                                       |
| DOCX / ODT       | Export as-is, or scale to fit page width; show a warning if fonts were substituted                                             |
| PPTX / ODP       | Slides per page (1, 2, 4, 6, 9 handout), include or hide speaker notes, include hidden slides, frame/border on slides          |
| XLSX / ODS / CSV | Fit all columns to page width, or one page per sheet, or actual size; choose which sheets; gridlines on/off; repeat header row |

Implementation notes:

- Use LibreOffice export filter options (`--convert-to 'pdf:<filter>:{json options}'`) where supported. For settings it can't express (e.g. fit-to-width on spreadsheets), run a small UNO/Basic script before export to adjust page styles.
- Install metric-compatible fonts (Liberation, Carlito, Caladea, Noto, DejaVu) in the image so layout is closest to Word/PowerPoint. Report substituted fonts to the student.
- Be honest in the UI: "For exact results, export to PDF from your own software and upload that." Always offer this tip next to the preview.
- Conversion is a background job with states `queued → converting → ready | failed`. Results are cached by (file hash + settings) so repeating a setting is instant.
- Original and converted files are both stored (within the 1-day retention).

## 6. Architecture

```
Student browser ──► Web (React static) ──┐
Owner browser   ──►                      ├─► API (Express) ──► PostgreSQL
Print agent     ──► (WebSocket + REST) ──┘       │
                                                 ├─► Storage (volume via StorageDriver)
                                                 ├─► Job queue (pg-boss, in Postgres)
                                                 ├─► Worker (LibreOffice, Ghostscript, qpdf)
                                                 └─► Realtime gateway (Socket.IO)
```

A **modular monolith**: one deployable API, one frontend, one database. Workers can run in the same image first and be split into a separate container later without code changes (they read from the same job queue).

### Repository layout

```
print-platform/
├── apps/
│   ├── web/                 # React + Vite + TS + Tailwind (student, owner, admin areas)
│   ├── api/                 # Express HTTP + Socket.IO server
│   ├── worker/              # job consumers (conversion, cleanup); can share api image
│   └── agent/               # shop print agent (phase 10)
├── packages/
│   ├── contracts/           # zod schemas + TS types shared by web/api/agent (single source of truth)
│   ├── domain/              # pure business rules: pricing, page ranges, order state machine (no I/O)
│   ├── config/              # env parsing/validation, shared eslint/tsconfig
│   └── ui/                  # shared React components (optional, later)
├── infra/                   # Dockerfiles, compose.yaml, Dokploy notes, backup scripts
├── docs/                    # architecture, ADRs, runbooks, API docs
└── README.md
```

### API module layout

Each module owns its routes, services, data access, events, and tests, and exposes only a small public interface.

```
apps/api/src/
├── modules/
│   ├── identity/        # users, sessions, password reset, roles
│   ├── shops/           # shops, membership, settings, QR/slug
│   ├── pricing/         # rates, estimate use-case
│   ├── documents/       # uploads, validation, storage keys, previews
│   ├── conversion/      # office -> pdf, grayscale, n-up, page ranges (job handlers live in worker)
│   ├── orders/          # order lifecycle, numbering, queue, lookup tokens
│   ├── printing/        # print jobs, printers/presets, agent devices
│   ├── retention/       # expiry, quota eviction, cleanup jobs
│   ├── audit/           # audit log
│   └── admin/           # platform admin use-cases
├── platform/            # cross-cutting adapters (ports + implementations)
│   ├── db/              # Prisma client, transaction helper
│   ├── storage/         # StorageDriver (local-disk implementation)
│   ├── queue/           # JobQueue (pg-boss implementation)
│   ├── realtime/        # RealtimeGateway (Socket.IO implementation)
│   ├── events/          # in-process domain event bus
│   ├── http/            # error handler, auth/tenant middleware, rate limits
│   └── observability/   # logger, metrics, request ids
├── app.ts               # builds Express app
└── server.ts            # boots HTTP + Socket.IO + workers
```

Module internal structure: `http/` (routes + controllers, thin) · `service/` (use-cases) · `repo/` (the only place that talks to the DB for this module) · `events.ts` · `index.ts` (public API).

## 7. Retention and storage quota

**Rules**

- **Files expire 24 hours after the order is created** (decided; counted from creation, not completion; the hour count is a setting, default 24). The student is told this on the confirmation page and in the privacy notice.
- **Limits are settings, not code:** global limit starts at **5 GB** (`STORAGE_MAX_BYTES` default, overridable from the admin panel). A per-shop limit can be set the same way and defaults to an equal share (or a fixed value such as 1 GB while there are few shops). Raising the limit later is a one-field change with no redeploy.
- A **retention job** runs every few minutes: deletes expired originals and print PDFs, sets `files_purged_at`, and marks stale `pending/accepted` orders `expired`. Order metadata (number, settings, price, status) stays for history and reporting, without file contents.
- **Storage limit:** configure `STORAGE_MAX_BYTES` (global) and optionally a per-shop quota. A quota job runs after every upload and on a schedule:
  - If usage is above the **high watermark** (e.g. 90%), delete the oldest files first until usage is under the **low watermark** (e.g. 75%).
  - Order of eviction: expired and finished orders first, then oldest by `created_at`. Orders still `pending/accepted` are evicted last, and only if there is no other way to get below the limit.
  - Evicted orders get status/flag `files_purged`; the dashboard shows "file no longer available" and the student sees a clear message.
  - Per-shop quotas prevent one busy shop from evicting everyone else's files.
- New uploads are refused with a friendly "shop is busy, try again shortly" if space is critically low and nothing can be freed.
- All deletions are logged to the audit log. Backups of the file volume should not be kept longer than the retention policy allows (or files should be excluded from backups; database-only backups are enough since files are temporary).

## 8. Real-time (Socket.IO)

- `RealtimeGateway` interface: `publishToShop(shopId, event)`, `publishToOrder(token, event)`, `publishToAgent(deviceId, event)`. Business modules call this interface only (through domain events), never Socket.IO directly.
- Rooms: `shop:<id>:owners` (authenticated via session cookie in the handshake and shop-membership check), `order:<lookupToken>` for students, and an `/agent` namespace for print agents (device-token auth).
- Events: `order.created`, `order.status_changed`, `order.files_purged`, `conversion.progress`, `print.job_status`.
- Clients always fetch state over REST first, then listen, and refetch after reconnect. Events are hints, not the source of truth.
- Single API instance for now. Keep the gateway swappable for the Redis/Postgres adapter if the API is ever scaled to several instances.
- Dokploy's Traefik proxy supports WebSockets; test WSS and reconnects in staging.

## 9. Keeping it modular and maintainable long-term

- **Enforced boundaries:** `dependency-cruiser` or `eslint-plugin-boundaries` in CI. A module may import only another module's `index.ts`, never its internals or its tables.
- **Ports and adapters:** storage, queue, realtime, converter, clock, and mailer are interfaces with swappable implementations and in-memory fakes for tests.
- **Domain package is pure:** pricing, page-range parsing, and the order state machine contain no I/O, so they are fast to test and safe to refactor.
- **Domain events** (`OrderCreated`, `OrderAccepted`, ...) decouple modules: realtime, audit, and notifications subscribe instead of being called directly.
- **Contracts first:** zod schemas in `packages/contracts` validate requests, responses, and socket events; types are shared with the frontend and agent. Generate OpenAPI docs from them.
- **Tenant safety by construction:** a request-scoped `TenantContext` is required by every repository method on shop-owned tables. Add Postgres row-level security as defence in depth (optional, evaluated in phase 1).
- **API versioning:** `/api/v1`; breaking changes go to `/v2`.
- **Config:** one validated env schema; no `process.env` access outside `packages/config`.
- **Migrations:** every schema change is a reviewed migration file, applied automatically on deploy in a controlled step.
- **Testing pyramid:** unit tests (domain), integration tests against a real Postgres (Testcontainers), API tests including a **tenant-isolation suite** that grows every phase, and a few end-to-end browser tests (Playwright) for the main flows.
- **Quality gates in CI:** typecheck, lint, boundary check, tests, build, and Docker build on every PR.
- **Documentation:** `docs/` with architecture overview, ADRs (short records of decisions, like this plan), runbooks (restore a backup, rotate secrets, add a shop), and a changelog.
- **Observability:** structured JSON logs with request ids, health/readiness endpoints, basic metrics, and error reporting (self-hosted, e.g. GlitchTip/Sentry-compatible) from phase 0.
- **Feature flags per shop** (stored in `shops.settings`) for things like colour printing, Office formats, and print agent, so features can be enabled gradually.

## 10. Data model (PostgreSQL)

| Table               | Key columns                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`             | id, email (unique, lowercased), password_hash, name, platform_role (`user`/`platform_admin`), is_active, created_at                                                                                                                                |
| `shops`             | id, slug (unique), name, status (`pending_approval`/`active`/`suspended`), address, contact_phone, timezone, currency, settings (jsonb: limits, flags, retention hours), storage_quota_bytes                                                       |
| `shop_members`      | shop_id, user_id, role (`owner`/`staff`), unique (shop_id, user_id)                                                                                                                                                                                |
| `shop_printers`     | id, shop_id, name, color_mode (`black_white`/`color`), supports_duplex, paper_sizes, agent_printer_name, is_default_for_color_mode                                                                                                                 |
| `platform_settings` | key, value (jsonb), updated_by, updated_at (e.g. `storage.max_bytes`, `storage.high_watermark`, `storage.low_watermark`, `retention.default_hours`)                                                                                                |
| `shop_rates`        | id, shop_id, paper_size, color_mode, sides, price_per_side, minimum_charge, effective_from                                                                                                                                                         |
| `orders`            | id (uuid), shop_id, order_number, lookup_token (unique), customer_name, status, print_settings (jsonb), estimated_amount, final_amount, rate_snapshot (jsonb), rejection_reason, files_purged_at, expires_at, created_at, updated_at, completed_at |
| `order_files`       | id, order_id, shop_id, original_name, original_key, print_pdf_key, mime_type, size_bytes, page_count, selected_pages, conversion_settings (jsonb), conversion_status, content_hash                                                                 |
| `order_counters`    | shop_id, date, last_number (primary key shop_id + date)                                                                                                                                                                                            |
| `print_jobs`        | id, order_id, shop_id, agent_id, status, requested_by, settings_snapshot (jsonb), error, created_at                                                                                                                                                |
| `agent_devices`     | id, shop_id, name, token_hash, last_seen_at, revoked_at                                                                                                                                                                                            |
| `audit_log`         | id, actor_type, actor_id, shop_id, action, entity, entity_id, metadata (jsonb), created_at                                                                                                                                                         |
| `shop_applications` | id, applicant details, status (`submitted`/`approved`/`rejected`), reviewed_by (for approval-based onboarding)                                                                                                                                     |

Rules: `UNIQUE (shop_id, order_number)`; index `(shop_id, status, created_at)` and `(expires_at)` for retention; atomic order numbers via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on `order_counters` inside the order transaction; storage keys are always relative; status transitions enforced by the domain state machine **and** a DB check.

Order state machine: `draft → processing → pending → accepted → printing → completed`, plus `pending → rejected`, `processing → failed`, and `pending/accepted → expired`. `printing` is optional when no agent is used.

## 11. Drizzle vs Prisma

Both are **ORMs / database toolkits**: they let your TypeScript code read and write PostgreSQL tables with type safety, and manage schema changes (migrations), instead of hand-writing SQL strings everywhere. If you've used Mongoose, this is the Postgres equivalent.

|                | Prisma                                                                     | Drizzle                                                  |
| -------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- |
| Style          | You describe tables in a `schema.prisma` file; it generates a typed client | You describe tables in TypeScript; queries look like SQL |
| Learning curve | Easiest, closest to Mongoose                                               | Needs more SQL knowledge                                 |
| Migrations     | Mature `prisma migrate`, plus Prisma Studio (visual DB browser)            | Good (`drizzle-kit`), less polished                      |
| Complex SQL    | Possible via raw queries                                                   | More natural                                             |
| Ecosystem      | Larger, more tutorials                                                     | Growing fast, lighter                                    |

**Recommendation: Prisma**, because of the easier workflow, mature migrations, and visual browser for debugging orders during the pilot. Concurrency-sensitive spots (order numbers, quota eviction) use `$queryRaw`/transactions where needed. Keep all DB access inside each module's `repo/` layer so the ORM could be swapped later if ever needed.

## 12. API outline (`/api/v1`)

**Public (students)**

- `GET  /shops/:slug`: shop info, rates, enabled features
- `POST /shops/:slug/uploads`: upload a file, returns a file id and starts processing
- `GET  /uploads/:fileId`: processing/conversion status, page count, preview URL (short-lived signed link)
- `POST /uploads/:fileId/conversion`: change Office conversion settings, re-run conversion
- `POST /shops/:slug/estimate`: price estimate
- `POST /shops/:slug/orders`: create order, returns `{ orderNumber, lookupToken }`
- `GET  /orders/:lookupToken`: status

**Owner/staff (session + shop membership)**

- `POST /auth/login | logout`, `GET /auth/me`, password reset
- `GET  /owner/shops/:shopId/orders`, `GET .../orders/:orderId`
- `GET  .../orders/:orderId/files/:fileId`: authenticated download/preview
- `PATCH .../orders/:orderId/status`: accept, reject, complete
- `POST .../orders/:orderId/print`: create a print job (agent) or return download
- `GET/PUT .../rates`, `GET/PUT .../printers`, `PATCH .../settings`, `GET/POST .../agents`
- Socket.IO: `/` for owners, `/agent` for agents

**Platform admin**

- `GET/POST /admin/shops`, `PATCH /admin/shops/:id/status`, `GET /admin/applications`, approve/reject
- `GET /admin/usage` (storage by shop), `GET /admin/audit`

**Public onboarding:** `POST /shop-applications` (a shop applies; an admin approves and the owner account is created).

## 13. Frontend areas

- **Student:** `/s/:slug` (wizard: upload → conversion settings + preview → print settings → review with price → confirmation with number and live status), `/s/:slug/order/:token`.
- **Owner:** `/owner` (live queue), order detail with preview, settings (rates, printers/presets, QR code, agents), history.
- **Admin:** shops, applications, users, storage usage, audit log.
- Mobile-first for students; owner dashboard works on laptop and phone. Accessible, with i18n set up from the start (English first; Hindi/regional strings added later).

## 14. Development phases

Each phase ends with something demonstrable and its tests green. Estimated total: about **14-18 weeks** for one developer, which is realistic given the larger scope.

**Phase 0: Foundations (1-2 weeks)**
Also in this phase (in parallel, owned by you and your friends, not blocking development): register a Microsoft Partner Center developer account for Store distribution of the print agent, and confirm individual registration is possible in India. Until it is ready, the pilot uses the manual installer (Track B).
Monorepo (pnpm + Turborepo), TypeScript, ESLint, boundary rules, CI, Docker dev environment (Postgres), env config, logger, health endpoints, Prisma setup, first migration, docs skeleton and ADRs.
Exit: one command runs everything; CI is green on an empty vertical slice.

**Phase 1: Identity, tenancy, roles (1-2 weeks)**
Users, shops, membership, sessions, password hashing, RBAC, tenant context, seed/admin CLI, audit logging foundation, owner login UI.
Exit: owner A can never read shop B (automated isolation tests).

**Phase 2: Storage and document pipeline for PDF and images (2 weeks)**
`StorageDriver`, upload validation (magic bytes, size, count), job queue + worker, PDF page counting, page-range parser, image→PDF, print-PDF builder (range, n-up, grayscale), previews with signed short-lived links.
Exit: bad/corrupt/huge/encrypted files are rejected safely; B&W output verified grayscale.

**Phase 3: Office conversion with settings and preview (2-3 weeks)**
LibreOffice worker image with fonts, sandbox and limits, conversion settings per type, re-conversion with caching, font-substitution warnings, preview UI with "confirm" step.
Exit: DOCX/PPTX/XLSX samples convert with adjustable settings; page count reflects the confirmed preview.

**Phase 4: Pricing and ordering (2 weeks)**
Rates and printer presets, estimate engine (unit-tested), atomic daily order numbers, student wizard, confirmation and status page, Turnstile and rate limits.
Exit: mobile student places an order; estimate matches hand calculations; concurrent submissions never duplicate numbers.

**Phase 5: Realtime and owner dashboard (2 weeks)**
Socket.IO gateway, live queue, accept/reject/complete, previews, instruction chips and printer preset display, final-amount override, notification sound, QR code generator, reconnect/refetch.
Exit: two-browser end-to-end flow works, including after a dropped connection.

**Phase 6: Retention, quota, audit, hardening (1-2 weeks)**
24-hour retention job, quota eviction with watermarks, expiry of stale orders, audit events, abuse protections, privacy notice, backups, load tests, security review.
Exit: expiry and eviction behave as specified in tests; full tenant-isolation and security suites pass.

**Phase 7: Print agent (2-3 weeks)**
Windows agent first (Electron tray app + bundled SumatraPDF, MSIX package published to the Microsoft Store), with CUPS support after. Work items: pairing-code flow from the dashboard (6-digit, single-use, 15 minutes), Store packaging and certification submission, automatic printer discovery with colour/duplex detection and auto-mapping, print job protocol over the `/agent` socket, test-page button, status reporting and retry, offline detection, auto-update, startup at login, fallback to manual print, setup docs. The dashboard's Print button creates the job; Reject is one click.
Exit: on a clean Windows PC, the owner completes setup in a few steps (install from the Store, type the pairing code) with no security warning, sees "Printing connected ✓", and from then on clicking Print produces the job on the right printer with the right colour, sides, and copies, without touching the print dialog.

**Phase 8: Platform admin and onboarding (1-2 weeks)**
Admin panel, shop applications and approval flow, per-shop feature flags, storage limit settings (global 5 GB default, per-shop), usage views.
Exit: a new shop can apply, get approved, set rates and printers, and start receiving orders without developer help; changing the storage limit takes effect without a redeploy.

**Phase 9: Deployment and pilot (1-2 weeks + pilot time)**
Production Dockerfiles and compose, Dokploy setup (domains, HTTPS, volumes, healthchecks, secrets), least-privilege DB user, automated off-server encrypted DB backups with a **restore test**, restart/redeploy test, staging environment. Pilot with one shop for 2 weeks.
Exit: the shop runs daily operations on it; feedback list captured.

**Phase 10: Pilot fixes (1-2 weeks)**
Fix usability issues, tune limits and conversion defaults, measure time saved.

**Phase 11: Later enhancements**
Notifications (WhatsApp/SMS/push), UPI payments, analytics, more languages, more shops' marketing pages, optional Redis/pg adapter if scaling to multiple API instances.

## 15. Definition of done for v1 (end of Phase 10)

- Two or more shops operate simultaneously with no data leakage, including by guessing IDs or tokens.
- A student can upload PDF, image, DOCX, PPTX, or XLSX from a mobile browser, adjust conversion settings, preview, and get a unique queue number.
- Invalid, oversized, corrupt, and unsupported files, and invalid page ranges, are rejected safely.
- Estimates match the rate card for copies, ranges, colour, duplex, and pages per sheet.
- B&W orders produce truly grayscale print PDFs.
- Owners see orders live and only need to click **Print** or **Reject**; the agent prints on the correct (B&W or colour) printer with the student's settings.
- Files are deleted after 24 hours; when storage passes the limit, oldest files are evicted per the rules.
- Restarting or redeploying loses no orders; a database backup has been restored on a clean machine.
- CI enforces tests, lint, and module boundaries.

## 16. Open questions

Settled: Prisma, 5 GB adjustable storage limit (the single pilot shop gets all of it), 24 hours from order creation, one B&W + one colour printer, Windows PC, both printers support 2-sided printing.

1. Confirm the exact Windows version and printer models when phase 7 starts (we will test the agent on the real printers; a printer without a proper Windows driver can behave differently).
2. Language: English only at launch, or Hindi/regional strings too?
3. Domain names to use on Dokploy.
4. Email provider for password resets and shop approvals (SMTP or a transactional service)?

## 17. Immediate next steps

1. Answer the open questions (especially 1-3).
2. Start Phase 0: scaffold the monorepo, CI, boundary rules, Postgres and Prisma.
3. Write the tenant-isolation test suite first in Phase 1 and keep extending it.
