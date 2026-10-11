# ADR 0006: Ordering, pricing, and the student interface

Status: accepted (2026-10-11)

## Pricing

- All money is **integer paise**. The unit charged is the **printed side**, at the shop's rate for (paper size, colour mode, single/double). Sides per copy = `ceil(selected pages / pages per sheet)`; double-sided only changes the sheet count (and which rate applies), because a sheet's blank back is not printed. A per-shop **minimum charge** applies to the whole order.
- The calculation lives in `packages/domain` (pure, heavily tested) and runs **on the server** for both the estimate and the order. The browser never supplies a price. The rate card in force is stored with the order, so later price changes do not alter existing orders. The amount is always labelled an _estimate_; the shop confirms it at the counter.
- Rates are per shop in `shop_rates` plus `shop_pricing.minimum_charge_paise`. Owners (not staff) can replace them with `PUT /owner/shops/:shopId/rates`. A combination without a rate is simply not offered: the form disables it and the API answers `422 rate_unavailable`.

## Orders

- An order has one or more **items**; each item is one uploaded document with its own settings (pages, copies, colour, sides, paper, pages per sheet). An upload can belong to one order item only (unique constraint).
- **Queue numbers** (`P001`...) are per shop and per day in the shop's timezone, allocated with an atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on `order_counters` inside the order's transaction. Eight simultaneous orders in the tests received eight distinct numbers.
- The student follows an order with a **secret lookup token** (192 bits, only its HMAC stored), kept in the page URL. The queue number is not an identifier.
- After the order row exists a background job **prepares the print PDF** for each item (selected pages, N-up, true grayscale for B&W) from a snapshot of the converted PDF taken at order time. Only then does the order become `pending` and visible to the shop. Files are kept 24 hours from order creation (uploads are extended to match).
- Bot protection: optional Cloudflare Turnstile on order creation (disabled when no secret is configured), plus per-IP rate limits on estimates and orders.

## Student interface

- React, Tailwind v4 with a small token system (`index.css`), fonts self-hosted through Fontsource: Archivo (wide, for headings and numbers), IBM Plex Sans, and IBM Plex Mono. The one memorable element is the **queue ticket**: a yellow token slip with perforated edges and the number stamped on it.
- Mobile first: large touch targets, a sticky bar with the running estimate and the next action, and a draft saved per tab (`sessionStorage`) so a refresh does not lose uploaded files.
- PDF previews are drawn with `pdf.js` onto canvases, because phone browsers cannot display multi-page PDFs inline. The library is loaded only when a preview is opened.
- Flow: Files (upload and convert) -> Settings (conversion options for Office files with live preview, print options, running price) -> Review (name, bot check, place order) -> Ticket page that polls for status until the order is finished.
