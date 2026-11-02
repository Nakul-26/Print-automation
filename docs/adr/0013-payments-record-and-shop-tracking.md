# 0013. Counter payments record and shop tracking

Status: accepted

## Decision

Students still pay at the counter; money never passes through the app. The shop **records** how each
order was paid so that both the shop and the platform can see real numbers.

## Payment record

- `orders.payment_method` (`cash` | `upi` | `card`), `paid_amount_paise`, `paid_at`. All three are set
  together by the owner action `record_payment` (one tap; the amount defaults to the final amount, or the
  estimate). Saying it again corrects the method or amount; the audit log keeps both
  (`order.payment_recorded`, `order.payment_corrected`).
- Allowed while the order is pending, accepted, printing or completed. Rejected, failed, expired and
  still-processing orders answer 409.
- "Collected" always means the sum of `paid_amount_paise`, never the estimate. A printed order without a
  payment is **unpaid**; the shop's queue keeps it in a "payment not recorded" list for a day and the
  daily summary and the admin both count it.
- `GET /owner/shops/:shopId/summary`: today's orders, printed, rejected, pages (printed sides), money
  collected by method, and the unpaid count and amount. "Today" is the shop's local date (the order's
  `queue_date`).

## Platform admin

- `GET /admin/overview`: shops by state, today and 30-day totals, a 30-day daily series (every day
  present, zero-filled), the payment split, printing apps online/offline, and a "needs attention" list
  (waiting for approval, printing app offline with open orders, 5+ unpaid printed orders, storage over
  80% of the shop's cap, no orders in 30 days).
- `GET /admin/shops/:id`: the shop with its 30-day numbers, daily series, payment split and its 20 latest
  orders. Orders show queue number, status, amount and method only; **student names are never shown**.
- `PUT /admin/shops/:id/notes`: private notes (2000 characters), stored in `shops.settings.adminNotes`.
  They are not part of any owner-facing response and the audit log records only that they changed.
- `GET /admin/shops` now carries `stats30`, `printingOnline` (live socket presence, not the last-seen
  time, which only moves on connect and job updates) and the notes.
- All numbers are counted by `queue_date`. Platform-wide windows are cut on `Asia/Kolkata` (every shop runs
  on Indian time today); per-shop day windows use the shop's own timezone.

## Module boundaries

The admin module still owns no tables. It gets two new ports from the composition root: `activity`
(from orders) and `usage.printingPresence` (from printing), plus `shops.setAdminNotes`. The aggregate
queries live in the orders repo (`statsByShop`, `dailyStats`, `methodTotals`, `recentForShop`).

## Not done

- Online payments (UPI/gateway), refunds, settlement: Phase 11.
- Exports (CSV), date-range pickers, per-shop timezone windows in the admin.
- Old orders keep no payment info (the columns are nullable); nothing is back-filled.
