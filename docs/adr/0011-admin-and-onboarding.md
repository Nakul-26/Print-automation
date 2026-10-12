# 0011. Platform admin and shop onboarding

Status: accepted

## Onboarding flow

1. A shop owner opens `/apply` and fills in shop name, link (slug), address, phone and their own
   account. `POST /api/v1/applications` (rate limited per connection, `APPLY_RATE_LIMIT_MAX`, and
   Turnstile when configured) creates the user, a shop in `pending_approval`, the owner membership and
   the starter rate card. Nothing is created if the slug or email is taken (checked first).
2. The owner can sign in at once and set prices (new **Prices** panel) and connect printers. Students
   get 404 for the shop until it is approved.
3. A platform admin opens `/admin`, sees the application under **Waiting** with a checklist (prices
   set, printing app linked), and presses **Approve**. The shop is live.

Platform admins are created on the server with `pnpm --filter @print/api cli create-admin`.

## Admin API (`/api/v1/admin`, platform admins only, 403 otherwise)

- `GET /shops[?status=]`: each shop with owner, storage used, open/total orders, onboarding
  checklist, cap and flags.
- `POST /shops/:id/approve | suspend | reactivate`: allowed moves are pending→active,
  pending/active→suspended, suspended→active; anything else is 409.
- `PATCH /shops/:id`: per-shop storage cap (bytes or `null`) and flags (`officeFiles`).
- `GET/PUT /settings`: the platform storage limit (min 100 MB).
- `GET /audit[?shopId=]`: recent activity. Every admin action is written to the audit log.

## Suspension is immediate

Suspending a shop (a) refuses its members at `requireShopAccess` (403 `shop_suspended`), (b) makes
student routes answer 404, (c) refuses the shop's printing app (socket handshake and file download),
and (d) drops live connections right away: the owners' dashboard sockets (room `shop:<id>`) and the
printing apps (room `agent-shop:<id>`), on every web process through the Postgres adapter. Reactivating
needs no re-pairing.

## Limits take effect without a redeploy

- The platform limit lives in `platform_settings` (`storage.max_bytes`) and is read through
  `platform/settings` with a 5 s cache, by both the upload check and the retention sweep (web and
  worker). `STORAGE_MAX_BYTES` stays as the default when nothing has been saved.
- The per-shop cap is checked when a student uploads (the file and its prepared copy count twice, as
  for the platform limit) and answers 503 `shop_storage_full`. Eviction stays global and oldest-first;
  the cap only stops one shop from filling the disk.
- `officeFiles=false` makes a shop accept only PDF and images (415 with a plain message). The flag is
  stored in `shops.settings.flags`; a missing key means on.

## Module boundaries

The new `admin` module owns no tables. It receives narrow ports from the composition root (shops,
identity, pricing, storage/order/printing usage), like orders and printing do.

## Not done

- No email: approval, rejection and suspension are not notified (planned with Phase 11 notifications).
  The owner sees the state on their dashboard.
- Staff accounts and invitations (shop members other than the owner) are still added by CLI.
- "Reject" an application is a suspension; there is no delete.
