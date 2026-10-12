# 0010. The print agent

Status: accepted

## What it is

A small Windows app (Electron tray app with SumatraPDF inside, `apps/agent`) that runs on the shop
PC. The owner presses **Print**; the platform queues one job per document; the agent downloads the
print PDF and prints it silently on the right printer with the student's colour, sides and copies.
The order is then completed automatically. If nothing is installed, Print behaves as before (the
order moves to "printing" and the owner prints by hand from the PDF).

## Protocol (`packages/contracts/src/agent.ts`)

- **Pairing.** The owner presses "Set up printing" and gets a 6-digit code (15 minutes, single use,
  stored only as an HMAC). The app sends it to `POST /api/v1/agent/pair` and receives a device
  token (shown once, stored as an HMAC). Wrong codes are rate-limited per IP (failures only) and
  globally. Pairing a new PC replaces the old one (one printing app per shop).
- **Connection.** The agent opens an outbound Socket.IO connection to the `/agent` namespace with
  the token. No ports are opened at the shop. One live connection per device.
- **`agent:hello`** (on every connect, and again whenever the PC's printers change): version and
  printer list (name, colour, two-sided, default, offline). The server stores it, auto-assigns
  printers the owner has not chosen yet (`autoMapPrinters`: colour printer for colour, B&W printer
  for B&W, a lone colour printer serves both, ambiguous cases left to the owner), and re-sends every
  unfinished job.
- **`job:new`**: printer, colour, duplex (`none`/`long`/`short`), copies, paper, and the path to
  download the PDF (`GET /api/v1/agent/jobs/:id/file`, bearer token, only the shop's own jobs).
- **`job:status`**: `printing` / `done` / `failed` + a plain-language error. Idempotent.
- The printer is resolved when a job is **sent**, not when it is created, so fixing the printer
  assignment and pressing Try again works.

## Reliability

- Jobs are queued in PostgreSQL (`print_jobs`) and survive an offline agent; they are delivered on
  reconnect. Orders pressed while the app is offline wait and print when it returns (or the owner
  chooses "Print by hand instead").
- The agent keeps a local ledger (`jobs.json`): a job is never printed twice even if the server
  re-sends it; outcomes that could not be delivered are re-sent after reconnecting; a job that was
  mid-print when the app died is reported as failed ("check the printer, then Try again") rather than
  printed a second time.
- A scheduled sweep (every minute) fails jobs that were sent but never finished (5 minutes,
  `PRINT_JOB_STALE_MINUTES`). Failures show on the order card with Try again / Print by hand.
- Before printing the agent checks the printer exists and is not offline and explains what to do.
- If the server drops the connection on purpose, the agent reconnects after a few seconds.
- Duplex: portrait pages flip on the long edge, landscape on the short edge (`duplexFor`). A
  two-sided order for a printer marked as not two-sided fails with a clear message instead of
  silently printing one-sided. **To verify on the real printers in the pilot.**

## Security

Device tokens are random, stored hashed, revocable (Remove this computer; replacing the PC), and
only grant access to that shop's jobs. The token is encrypted at rest with the Windows account
(Electron `safeStorage`). The window uses context isolation, a sandbox, a strict CSP and no remote
content. Agents are not browsers: no cookies, no Origin.

## Distribution (two tracks, one codebase)

`pnpm --filter @print/agent pack:installer` builds the manual installer (NSIS `.exe`; Windows shows
the SmartScreen warning once; updates itself from `UPDATE_URL`). `pack:store` builds the `.appx`
for the Microsoft Store once Partner Center gives us the identity values (`STORE_IDENTITY_NAME`,
`STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME`); the Store then updates it and there is no
warning. SumatraPDF is downloaded at build time and checked against a pinned SHA-256.

The dashboard links come from `VITE_AGENT_STORE_URL` and `VITE_AGENT_DOWNLOAD_URL`.

## Testing without real printers

`--record-dir` keeps each PDF and the exact SumatraPDF command instead of printing, and
`--fake-printers` supplies a printer list; both work in the app and in the headless runner
(`pnpm --filter @print/agent cli`). The protocol is covered by API integration tests (a fake agent
over real sockets) and by agent tests (a fake server).

## Not done yet

- CUPS (Linux/macOS) printing: the core is platform-neutral; only a `PrintPort` for `lp` and a
  printer lister are missing.
- Checking colour/duplex/margins on the real printers, and a first Store submission (waiting for
  the Partner Center account).
