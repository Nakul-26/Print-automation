# Pilot checklist (one shop, two weeks)

## Before the shop starts using it

**Server** (see `deployment.md`, `runbook.md`)

- [ ] Production deployed; `https://print.fiveorbit.tech/health` returns ok through the tunnel.
- [ ] First platform admin created; `/admin` works (ideally behind Cloudflare Access).
- [ ] First backup is in the R2 bucket; **restore drill done** with the offline key; key stored safely.
- [ ] Backup alert (healthchecks.io) set up and tested once by stopping the `backup` container.
- [ ] Uptime check on `/health` set up.
- [ ] Docker starts on boot and the PC powers on after a power cut (test it: pull the plug).
- [ ] Load test run on staging; `WORKER_REPLICAS` chosen and noted in `load-testing.md`.

**Shop setup** (the owner does this, you watch; anything you have to explain is a bug to fix)

- [ ] Owner applies at `/apply`; you approve in `/admin`.
- [ ] Owner sets prices in **Prices**; student page shows them.
- [ ] Printing app installed on the shop PC from the installer (`apps/agent/release/…Setup.exe`;
      Windows will warn once: _More info → Run anyway_), linked with the 6-digit code.
- [ ] Printers detected and assigned; **Send test page** prints on both printers.
- [ ] QR code printed and placed at the counter.

**Real-printer checks** (`print-agent-setup.md`, "For us") — these could not be tested without hardware:

- [ ] A two-sided portrait order flips on the long edge; a landscape one on the short edge.
      (If wrong: one line in `duplexFor`, `packages/domain/src/printers.ts`.)
- [ ] A colour order comes out in colour; a B&W order uses no colour toner.
- [ ] Margins and scaling match the preview the student saw (A4 and, if offered, A3).
- [ ] Copies, page ranges and pages-per-sheet come out as ordered.
- [ ] Unplugging a printer / removing paper shows a clear message with **Try again** / **Print by hand**.
- [ ] Closing the printing app and reopening it: waiting orders print once, never twice.

## During the two weeks

Every day (2 minutes): `/admin` → shop card (open orders, storage), backup email silent, dashboard
shows "Printing connected". Keep a log: date, what happened, who noticed.

Feedback to collect (ask the owner on days 3, 7 and 14, and one or two students each week):

1. Time from "student arrives" to "printed" before vs now (owner's estimate; or note five orders).
2. Orders that needed a human fix (wrong settings, file didn't open, printer error). Count and describe.
3. Anything the owner stopped trusting or had to double-check.
4. Students: was it clear? Anything they couldn't do on a phone?
5. Does the owner want anything the app doesn't do (reports, notifications, UPI)? Feeds Phase 11.

## Exit (end of week 2)

- [ ] The shop ran daily operations on it without developer help for the last 5 working days.
- [ ] Feedback list written up; each item marked _fix in Phase 10_, _later_, or _won't do_.
- [ ] At least one more restore drill and one real backup verified in the bucket.
