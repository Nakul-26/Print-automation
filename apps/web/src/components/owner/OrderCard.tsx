import { useState } from 'react';
import type { OrderActionBody, OwnerOrder, OwnerOrderItem } from '@print/contracts';
import { PAPER_LABEL, PRINTER_LABEL, SIDES_LABEL, formatRupees, timeAgo } from '../../lib/format';
import { ownerApi } from '../../lib/owner-api';
import { Button } from '../ui';

const REJECT_REASONS = [
  'Out of paper',
  'Cannot print this file',
  'Printer problem',
  'Shop is closing',
];

function Chip({ children, tone = 'plain' }: { children: string; tone?: 'plain' | 'color' | 'bw' }) {
  const style = {
    plain: 'bg-line/60 text-ink',
    bw: 'bg-ink text-white',
    color: 'bg-magenta text-white',
  }[tone];
  return (
    <span className={`rounded-md px-2 py-1 font-mono text-xs font-medium ${style}`}>
      {children}
    </span>
  );
}

/** Everything the shop needs to know about one document, as short chips. The settings are applied automatically. */
function ItemRow({
  item,
  order,
  shopId,
  onPreview,
}: {
  item: OwnerOrderItem;
  order: OwnerOrder;
  shopId: string;
  onPreview: (url: string, title: string) => void;
}) {
  const s = item.settings;
  const title = `${order.queueNumber} · ${item.originalName}`;
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words font-medium">{item.originalName}</p>
        <p className="shrink-0 font-mono text-sm text-muted">{formatRupees(item.amountPaise)}</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip tone={s.colorMode === 'color' ? 'color' : 'bw'}>{PRINTER_LABEL[s.colorMode]}</Chip>
        <Chip>{SIDES_LABEL[s.sides]}</Chip>
        <Chip>{PAPER_LABEL[s.paperSize]}</Chip>
        <Chip>{`${s.copies} ${s.copies === 1 ? 'copy' : 'copies'}`}</Chip>
        {s.pagesPerSheet > 1 && <Chip>{`${s.pagesPerSheet} per sheet`}</Chip>}
        <Chip>
          {s.pageSelection === 'custom' && s.pages
            ? `pages ${s.pages}`
            : `${item.selectedPageCount} ${item.selectedPageCount === 1 ? 'page' : 'pages'}`}
        </Chip>
        <Chip>{`${item.printedSides} ${item.printedSides === 1 ? 'side' : 'sides'} total`}</Chip>
      </div>
      <div className="mt-2 flex gap-4 text-sm">
        {item.fileReady ? (
          <>
            <button
              type="button"
              className="font-medium text-cyan underline"
              onClick={() => onPreview(ownerApi.fileUrl(shopId, order.id, item.id), title)}
            >
              Preview
            </button>
            <a
              className="font-medium text-cyan underline"
              href={ownerApi.fileUrl(shopId, order.id, item.id, true)}
            >
              Download PDF
            </a>
          </>
        ) : (
          <span className="text-muted">File is being prepared…</span>
        )}
      </div>
    </li>
  );
}

export function OrderCard({
  order,
  shopId,
  busy,
  error,
  onAct,
  onPreview,
}: {
  order: OwnerOrder;
  shopId: string;
  busy: boolean;
  error: string | null;
  onAct: (body: OrderActionBody) => void;
  onPreview: (url: string, title: string) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'reject' | 'complete'>('idle');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState(String(order.estimatedAmountPaise / 100));

  const open = order.status === 'pending' || order.status === 'accepted';
  const printing = order.status === 'printing';
  const finished = ['completed', 'rejected', 'failed', 'expired'].includes(order.status);
  const allReady = order.items.every((i) => i.fileReady);

  const amountPaise = Math.round(Number(amount) * 100);
  const amountValid = Number.isFinite(amountPaise) && amountPaise >= 0 && amount.trim() !== '';

  return (
    <article
      className={`rounded-card border bg-card p-4 sm:p-5 ${
        printing ? 'border-cyan' : finished ? 'border-line opacity-75' : 'border-ink/30'
      }`}
      aria-label={`Order ${order.queueNumber}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="display text-4xl" style={{ fontStretch: '125%' }}>
            {order.queueNumber}
          </p>
          <p className="mt-1 truncate text-base font-semibold">{order.customerName ?? 'No name'}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="display text-2xl">
            {formatRupees(order.finalAmountPaise ?? order.estimatedAmountPaise)}
          </p>
          <p className="font-mono text-xs text-muted">
            {order.finalAmountPaise === null ? 'estimate' : 'collected'} ·{' '}
            {timeAgo(order.createdAt)}
          </p>
        </div>
      </header>

      <ul className="mt-2 divide-y divide-line">
        {order.items.map((item) => (
          <ItemRow key={item.id} item={item} order={order} shopId={shopId} onPreview={onPreview} />
        ))}
      </ul>

      {order.status === 'rejected' && (
        <p className="mt-3 text-sm text-magenta">Rejected: {order.rejectionReason}</p>
      )}
      {order.status === 'failed' && (
        <p className="mt-3 text-sm text-magenta">
          The files could not be prepared. Ask the student to place the order again.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-magenta-wash px-3 py-2 text-sm text-magenta">
          {error}
        </p>
      )}

      {open && mode === 'idle' && (
        <div className="mt-4 flex gap-3">
          <Button
            className="flex-1"
            disabled={busy || !allReady}
            onClick={() => onAct({ action: 'print' })}
          >
            {busy ? 'Working…' : 'Print'}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => setMode('reject')}>
            Reject
          </Button>
        </div>
      )}

      {open && mode === 'reject' && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) onAct({ action: 'reject', reason: reason.trim() });
          }}
        >
          <p className="text-sm font-medium">Why? The student will see this.</p>
          <div className="flex flex-wrap gap-2">
            {REJECT_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={`min-h-10 rounded-lg border px-3 text-sm ${
                  reason === r ? 'border-magenta bg-magenta-wash text-magenta' : 'border-line'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="Or type a reason"
            aria-label="Reason for rejecting"
            className="min-h-11 w-full rounded-lg border border-line px-3"
          />
          <div className="flex gap-3">
            <Button
              type="submit"
              variant="secondary"
              className="flex-1"
              disabled={busy || !reason.trim()}
            >
              Reject order
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {printing && mode !== 'complete' && (
        <div className="mt-4">
          <p className="mb-3 flex items-center gap-2 text-sm font-medium text-cyan-deep">
            <span className="pulse-dot inline-block size-2.5 rounded-full bg-cyan" aria-hidden />
            Printing. Mark it done when the student has collected it.
          </p>
          <Button className="w-full" disabled={busy} onClick={() => setMode('complete')}>
            Done
          </Button>
        </div>
      )}

      {printing && mode === 'complete' && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (amountValid) {
              onAct({
                action: 'complete',
                ...(amountPaise !== order.estimatedAmountPaise
                  ? { finalAmountPaise: amountPaise }
                  : {}),
              });
            }
          }}
        >
          <label className="block text-sm font-medium">
            Amount collected (₹)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="mt-1.5 min-h-12 w-full rounded-lg border border-line px-3 font-mono text-lg"
            />
          </label>
          <div className="flex gap-3">
            <Button type="submit" className="flex-1" disabled={busy || !amountValid}>
              {busy ? 'Saving…' : 'Mark as done'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>
              Back
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
