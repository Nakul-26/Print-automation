# 0007. Realtime updates and the owner dashboard

Status: accepted

## Decisions

- **Events carry no data.** The Socket.IO gateway (`platform/realtime`) only says "the queue changed" or "this order changed". Browsers refetch over HTTP, where authorisation already lives. A missed event costs a refresh, never a leak, and every (re)connect refetches.
- **The gateway is generic.** It knows nothing about orders. Modules register the events they accept (`shop:watch`, `order:watch`) and publish to rooms they name. Handshake auth reads the session cookie via the identity module; connections from another origin are refused.
- **Rooms.** `shop:<id>` for the owner's dashboard (membership checked on every join). `order:<hmac>` for a student, joined only with the secret order token. Students also join their shop's room to learn that the number of orders ahead changed.
- **Actions are atomic and scoped.** `print`, `reject` (with a reason the student sees) and `complete` (with the amount collected) use a conditional update on the expected current status, so two clicks cannot both win. Every query includes the shop id taken from the authenticated tenant; another shop's order id is a plain 404.
- **Print files** are streamed to the shop only, `no-store`, for preview or manual download.
- **Fallback polling** (20-30 s) remains for networks that block WebSockets.

## Known limits

- "Print" sets the order to `printing`. Until the print agent (phase 7) exists the owner opens or downloads the PDF and prints it; the settings chips show which printer and options apply.
- A socket stays authorised for the shop until it disconnects, even if the user is removed. Revocation on membership change is a phase 6 item.
