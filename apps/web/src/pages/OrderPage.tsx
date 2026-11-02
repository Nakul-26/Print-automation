import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { REALTIME, type CheckoutPayload, type OrderView } from '@print/contracts';
import { Button, Card, Notice, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useRealtime } from '../lib/realtime';
import { openCheckout } from '../lib/razorpay';
import { describeSettings, formatRupees, paymentMethodLabel, statusCopy } from '../lib/format';

// Live updates arrive over the socket; this slow poll only covers a socket that is blocked.
const FALLBACK_POLL_MS = 20_000;
// While a payment is open, ask the payment provider this often (the server checks, never the browser).
const PAYMENT_POLL_MS = 8_000;
const LIVE: OrderView['status'][] = ['processing', 'pending', 'accepted', 'printing'];

export function OrderPage() {
  const { slug = '', token = '' } = useParams();
  const location = useLocation();
  const arrival = location.state as { order?: OrderView; checkout?: CheckoutPayload | null } | null;
  const [order, setOrder] = useState<OrderView | null>(arrival?.order ?? null);
  const [checkout, setCheckout] = useState<CheckoutPayload | null>(arrival?.checkout ?? null);
  const [error, setError] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payMessage, setPayMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  // The payment window opens by itself only right after the order was placed, never on a later visit.
  const openOnArrival = useRef<CheckoutPayload | null>(arrival?.checkout ?? null);

  const awaiting = order?.payment.state === 'awaiting';
  const live = order ? LIVE.includes(order.status) : true;

  const refresh = useCallback(async () => {
    try {
      const next = await api.getOrder(token);
      setOrder(next);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError(
          'We could not find this order. The link may be wrong, or the order is more than a day old.',
        );
      }
      // Any other failure is a dropped connection; the next event or poll tries again.
    }
  }, [token]);

  useRealtime({
    watch: live ? { event: REALTIME.watchOrder, payload: { token } } : null,
    changeEvents: [REALTIME.orderChanged, REALTIME.queueChanged],
    // A little jitter so a busy shop's updates do not hit the server in one burst.
    onChange: () => void setTimeout(refresh, Math.random() * 400),
  });

  useEffect(() => {
    void refresh();
    if (!live || error) return;
    const timer = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, live, error]);

  useEffect(() => {
    if (order) document.title = `${order.queueNumber} · ${order.shopName}`;
  }, [order]);

  /** Opens the payment window, then lets the server confirm what happened. */
  const pay = useCallback(
    async (payload: CheckoutPayload) => {
      if (!order) return;
      setPayBusy(true);
      setPayMessage(null);
      const result = await openCheckout(payload, `Order ${order.queueNumber} at ${order.shopName}`);
      try {
        if (result.kind === 'paid') {
          await api.confirmPayment(token, result.body);
          setPayMessage({ tone: 'ok', text: 'Payment received. The shop can see your order now.' });
          setCheckout(null);
        } else if (result.kind === 'failed') {
          setPayMessage({ tone: 'error', text: result.message });
        } else {
          setPayMessage({
            tone: 'error',
            text: 'The payment was not completed. You can try again, or pay at the counter.',
          });
        }
      } catch (err) {
        setPayMessage({
          tone: 'error',
          text:
            err instanceof ApiError
              ? err.message
              : 'We could not confirm the payment yet. If money was taken, it will show up here shortly.',
        });
      } finally {
        setPayBusy(false);
        void refresh();
      }
    },
    [order, token, refresh],
  );

  // Straight after placing the order, open the payment window once.
  useEffect(() => {
    const payload = openOnArrival.current;
    if (!awaiting || !payload || !order) return;
    openOnArrival.current = null;
    void pay(payload);
  }, [awaiting, order, pay]);

  // Coming back to an unpaid order (new tab, closed window): get what is needed to pay, and keep checking.
  useEffect(() => {
    if (!awaiting) return;
    let stopped = false;
    const check = async () => {
      try {
        const status = await api.refreshPayment(token);
        if (stopped) return;
        setCheckout(status.checkout);
        if (status.payment.state !== 'awaiting') void refresh();
      } catch {
        // offline: try again on the next tick
      }
    };
    void check();
    const timer = setInterval(() => void check(), PAYMENT_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [awaiting, token, refresh]);

  const switchToCounter = async () => {
    setPayBusy(true);
    setPayMessage(null);
    try {
      await api.payAtCounter(token);
    } catch (err) {
      setPayMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Could not change the payment. Try again.',
      });
    } finally {
      setPayBusy(false);
      void refresh();
    }
  };

  if (error) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <Notice tone="error">{error}</Notice>
        <Link to={`/s/${slug}`} className="mt-4 inline-block font-medium text-cyan underline">
          Place a new order
        </Link>
      </main>
    );
  }
  if (!order) {
    return (
      <main className="mx-auto w-full max-w-xl px-4 py-10">
        <Spinner label="Finding your order" />
      </main>
    );
  }

  const copy = awaiting
    ? {
        title: 'Waiting for your payment',
        detail: 'The shop sees your order as soon as the payment goes through.',
        tone: 'wait' as const,
      }
    : statusCopy(order.status);

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-10 pt-6 sm:pt-10">
      <Ticket order={order} />

      {awaiting && (
        <PayNow
          order={order}
          checkout={checkout}
          busy={payBusy}
          message={payMessage}
          onPay={() => checkout && void pay(checkout)}
          onCounter={() => void switchToCounter()}
        />
      )}

      <section className="mt-5" aria-live="polite">
        <div
          className={`rounded-card border p-4 ${
            copy.tone === 'bad'
              ? 'border-magenta/40 bg-magenta-wash'
              : copy.tone === 'done'
                ? 'border-ok/30 bg-ok-wash'
                : 'border-line bg-card'
          }`}
        >
          <p className="flex items-center gap-2 text-lg font-semibold">
            {live && (
              <span className="pulse-dot inline-block size-2.5 rounded-full bg-cyan" aria-hidden />
            )}
            {copy.title}
          </p>
          {copy.detail && <p className="mt-1 text-sm text-muted">{copy.detail}</p>}
          {order.status === 'rejected' && order.rejectionReason && (
            <p className="mt-1 text-sm">Reason: {order.rejectionReason}</p>
          )}
          {!awaiting &&
            (order.status === 'pending' ||
              order.status === 'processing' ||
              order.status === 'accepted') && (
              <p className="mt-3 font-mono text-sm">
                {order.aheadCount === 0
                  ? 'You are next in line.'
                  : `${order.aheadCount} ${order.aheadCount === 1 ? 'order is' : 'orders are'} ahead of you.`}
              </p>
            )}
        </div>
      </section>

      <PaymentNote order={order} message={awaiting ? null : payMessage} />

      <Card className="mt-5">
        <h2 className="font-mono text-xs uppercase tracking-wide text-muted">What you ordered</h2>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((item, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{item.originalName}</p>
                <p className="text-sm text-muted">{describeSettings(item.settings)}</p>
              </div>
              <p className="shrink-0 font-mono">{formatRupees(item.amountPaise)}</p>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t border-ink pt-3">
          <span className="font-medium">
            {order.finalAmountPaise === null ? 'Estimated total' : 'Total'}
          </span>
          <span className="display text-2xl">
            {formatRupees(order.finalAmountPaise ?? order.totalPaise)}
          </span>
        </div>
        {order.payment.state === 'none' && (
          <p className="mt-2 text-xs text-muted">
            Pay at the counter when you collect your prints.
          </p>
        )}
      </Card>

      <p className="mt-5 text-center text-sm text-muted">
        Keep this page open, or save the link. Your files are deleted after one day.
      </p>
      <p className="mt-3 text-center">
        <Link to={`/s/${slug}`} className="font-medium text-cyan underline">
          Place another order
        </Link>
      </p>
    </main>
  );
}

/** The call to pay: shown while the money has not arrived. */
function PayNow({
  order,
  checkout,
  busy,
  message,
  onPay,
  onCounter,
}: {
  order: OrderView;
  checkout: CheckoutPayload | null;
  busy: boolean;
  message: { tone: 'ok' | 'error'; text: string } | null;
  onPay: () => void;
  onCounter: () => void;
}) {
  return (
    <Card className="mt-5 border-cyan">
      <h2 className="display text-xl">Pay {formatRupees(order.payment.amountPaise)}</h2>
      <p className="mt-1 text-sm text-muted">
        Your order is placed. Finish the payment so the shop can start on it.
      </p>
      {checkout?.testMode && (
        <p className="mt-2 rounded-lg bg-slip px-3 py-2 text-sm font-medium">
          Test mode: no real money is charged.
        </p>
      )}
      {message && (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className="mt-4 space-y-2">
        <Button className="w-full" disabled={busy || !checkout} onClick={onPay}>
          {busy ? 'Working…' : `Pay ${formatRupees(order.payment.amountPaise)}`}
        </Button>
        <Button variant="secondary" className="w-full" disabled={busy} onClick={onCounter}>
          Pay at the counter instead
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        If you already paid and this page has not updated, wait a few seconds. We check
        automatically.
      </p>
    </Card>
  );
}

/** What happened to the money, once it is no longer waiting. */
function PaymentNote({
  order,
  message,
}: {
  order: OrderView;
  message: { tone: 'ok' | 'error'; text: string } | null;
}) {
  const p = order.payment;
  if (p.state === 'paid') {
    return (
      <div className="mt-4 rounded-card border border-ok/30 bg-ok-wash p-4 text-sm">
        <p className="font-semibold text-ok">
          Paid {formatRupees(p.amountPaise)} online ({paymentMethodLabel(p.method)}) ✓
        </p>
        <p className="mt-1 text-muted">Nothing to pay at the counter.</p>
      </div>
    );
  }
  if (p.state === 'refunded') {
    return (
      <div className="mt-4 rounded-card border border-line bg-card p-4 text-sm">
        <p className="font-semibold">Your payment of {formatRupees(p.amountPaise)} was refunded.</p>
        <p className="mt-1 text-muted">
          It usually reaches your account in 5 to 7 working days, depending on your bank.
        </p>
      </div>
    );
  }
  if (p.state === 'refund_failed') {
    return (
      <div className="mt-4 rounded-card border border-magenta/40 bg-magenta-wash p-4 text-sm">
        <p className="font-semibold text-magenta">
          We could not send your refund of {formatRupees(p.amountPaise)} automatically.
        </p>
        <p className="mt-1">Please tell the shop. They have been notified and will return it.</p>
      </div>
    );
  }
  return message ? (
    <div className="mt-4">
      <Notice tone={message.tone}>{message.text}</Notice>
    </div>
  ) : null;
}

/** The queue token: a paper slip with torn edges and the number stamped on it. */
function Ticket({ order }: { order: OrderView }) {
  const time = new Date(order.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <article
      className="slip text-ink drop-shadow-[0_6px_0_rgba(17,21,26,0.12)]"
      aria-label={`Queue ticket ${order.queueNumber}`}
    >
      <div className="px-7 pb-5 pt-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em]">{order.shopName}</p>
        <p className="mt-5 font-mono text-xs uppercase tracking-[0.18em]">Your number</p>
        <p
          className="stamp display my-1 text-[5.5rem] leading-none sm:text-[6.5rem]"
          style={{ fontStretch: '125%' }}
        >
          {order.queueNumber}
        </p>
        {order.customerName && <p className="text-lg font-semibold">{order.customerName}</p>}
      </div>
      <div className="perforation mx-5" aria-hidden />
      <div className="flex items-center justify-between px-7 pb-6 pt-4 font-mono text-xs">
        <span>
          {order.items.length} {order.items.length === 1 ? 'file' : 'files'} · {time}
        </span>
        <span className="font-medium">Show this at the counter</span>
      </div>
    </article>
  );
}
