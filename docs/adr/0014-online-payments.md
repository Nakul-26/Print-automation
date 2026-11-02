# 0014. Online payments, in each shop's own gateway account

Status: accepted. Replaces the "record how they paid at the counter" buttons of ADR 0013 (those are removed).

## Decision

Students can pay for an order on the website. Each **shop connects its own Razorpay account**: the
money goes straight to the shop's bank, the platform never holds or settles funds, and there is no
payout or refund liability for the platform. Paying at the counter stays as the alternative, and
asks nothing: nobody is asked how they paid.

Razorpay was chosen because it has no setup fee and, for a new account, advertises a 0% platform
fee for the first 90 days (up to a cumulative ₹5 lakh), so the pilot costs nothing. UPI itself has no
bank charge up to ₹2,000 per payment. These offers change; shops check Razorpay's current pricing.
The provider sits behind a small port (`PaymentGateway`), so Cashfree or another can be added later.

## The student's journey

1. Review step: **Pay online now** or **Pay at the counter** (online only appears when the shop has it
   on and the order is at least ₹1).
2. Online: the server opens a Razorpay order with the shop's keys first (a failure leaves nothing
   behind), then creates the order with `payment_state = awaiting`, then stores the payment.
3. Razorpay's own payment window opens on our page (UPI, cards, netbanking). It is the only place card
   details are entered; they never touch our servers.
4. The window returns `order_id | payment_id | signature`. The browser sends it to
   `POST /orders/:token/payment/confirm`; the server recomputes the HMAC-SHA256 with the shop's
   secret and **believes nothing else**. A valid signature plus the gateway's own record of the
   payment (amount must equal the order's) marks the order **paid**, and only then does it appear
   in the shop's queue.
5. Closed the window? `POST …/payment/refresh` and a background check (every minute) ask Razorpay for
   the order's payments, so a payment is found even if the browser never reported it. No webhook has
   to be set up by the shop.
6. The student can switch to "pay at the counter" while unpaid; the server first checks with the
   gateway so a payment that just went through is never dropped.
7. Unpaid after 20 minutes: the order is closed (expired) and the shop never sees it.
   A payment that still arrives afterwards is **refunded automatically** (found by the confirm call
   or the background check for two hours).

## Refunds

When an order that was paid online ends without being printed (the shop rejects it, files fail to
prepare, it expires, or storage pressure removes its files) the student is refunded in full:
`paid → refund_pending → refunded`. The refund uses an idempotency key, so retrying never refunds
twice, and "already refunded" counts as done. A temporary outage is retried every minute for up to
6 hours; a permanent refusal (for example, not enough balance in the shop's account) becomes
`refund_failed`, shown to the shop, the student and the platform admin ("Refund needs attention").
Printed orders are never refunded automatically.

## Where things live

- `platform/payments`: the Razorpay client (orders, payments, capture, refund, signature check) and a
  secret box (AES-256-GCM). No database, no business rules.
- `modules/payments` owns `shop_payment_settings` (keys, on/off) and `online_payments` (one row per
  order). Routes: owner settings under `/owner/shops/:id/payments` (owner only; staff get 403) and the
  student's `/orders/:token/payment…`.
- `modules/orders` keeps the order's own copy (`payment_state`, `payment_method`, `paid_amount_paise`,
  `paid_at`) so queue, summary and admin queries stay inside one module. `awaiting` orders are hidden
  from the queue, the "orders ahead" count, the summary, and the admin numbers. The two modules talk
  through narrow ports wired in the composition root.
- A paid order is settled for exactly what was paid; the shop cannot change the amount.

## Keys and secrets

- The shop pastes its Key ID and Key Secret in the dashboard (**Payments**, owner only). The keys are
  checked against Razorpay before they are saved. The secret is stored encrypted and is never returned
  by any endpoint, never logged, and never in an audit entry.
- The encryption key is derived from `PAYMENTS_ENCRYPTION_KEY` when set, otherwise from
  `SESSION_SECRET`. Changing that secret makes saved keys unreadable; shops then re-enter them.
  Set `PAYMENTS_ENCRYPTION_KEY` once and keep it to avoid that.
- Test keys (`rzp_test_…`) show a "test mode" banner to the owner and the student: no real money moves.
- Keys cannot be changed or removed while payments are in progress (409), which would strand them.

## Security notes

- The browser is never trusted: only the signature check and the gateway's own record count.
- The Content-Security-Policy and `Permissions-Policy` allow `checkout.razorpay.com` and
  `api.razorpay.com`, loaded only when a student actually pays.
- Confirmation, refresh and counter endpoints are rate limited like order creation.

## Not done

- Webhooks (the background check replaces them; a webhook would only make confirmation faster).
- Partial refunds, a refund button for printed orders (the shop refunds those from its own Razorpay
  dashboard), settlement reports. Other providers.
- Counter payments are not tracked at all: the shop sees "pay at the counter: collect ₹X".
