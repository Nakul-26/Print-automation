import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { OrderView } from '@print/contracts';
import { Card, Notice, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { describeSettings, formatRupees, statusCopy } from '../lib/format';

const POLL_MS = 4000;
const LIVE: OrderView['status'][] = ['processing', 'pending', 'accepted', 'printing'];

export function OrderPage() {
  const { slug = '', token = '' } = useParams();
  const location = useLocation();
  const [order, setOrder] = useState<OrderView | null>(
    (location.state as { order?: OrderView } | null)?.order ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        const next = await api.getOrder(token);
        if (cancelled) return;
        setOrder(next);
        setError(null);
        if (LIVE.includes(next.status)) timer = setTimeout(load, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setError(
            'We could not find this order. The link may be wrong, or the order is more than a day old.',
          );
          return;
        }
        // A dropped connection should not end the live updates.
        timer = setTimeout(load, POLL_MS * 2);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token]);

  useEffect(() => {
    if (order) document.title = `${order.queueNumber} · ${order.shopName}`;
  }, [order]);

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

  const copy = statusCopy(order.status);
  const live = LIVE.includes(order.status);

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-10 pt-6 sm:pt-10">
      <Ticket order={order} />

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
          {(order.status === 'pending' ||
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
        <p className="mt-2 text-xs text-muted">Pay at the counter when you collect your prints.</p>
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
