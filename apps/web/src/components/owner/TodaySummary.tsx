import type { OwnerSummary } from '@print/contracts';
import { formatRupees, paymentMethodLabel } from '../../lib/format';

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="display text-2xl">{value}</p>
      <p className="font-mono text-xs uppercase tracking-wide text-muted">{label}</p>
    </div>
  );
}

/** What the shop did today: orders, pages, and the money received online. */
export function TodaySummary({ summary }: { summary: OwnerSummary }) {
  return (
    <section aria-label="Today" className="mb-6 rounded-card border border-line bg-card p-4 sm:p-5">
      <h2 className="mb-3 font-mono text-xs uppercase tracking-wide text-muted">Today</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Figure label="Paid online" value={formatRupees(summary.collectedPaise)} />
        <Figure label="Printed" value={String(summary.printed)} />
        <Figure label="Pages" value={String(summary.pages)} />
        <Figure label="Rejected" value={String(summary.rejected)} />
      </div>
      {summary.byMethod.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          {summary.byMethod.map((m) => (
            <span key={m.method}>
              {paymentMethodLabel(m.method)} {formatRupees(m.amountPaise)} ({m.count})
            </span>
          ))}
        </p>
      )}
      {summary.counterCount > 0 && (
        <p className="mt-3 text-sm text-muted">
          To collect at the counter: {summary.counterCount} printed{' '}
          {summary.counterCount === 1 ? 'order' : 'orders'} ({formatRupees(summary.counterPaise)}).
        </p>
      )}
      {summary.refundFailed > 0 && (
        <p className="mt-3 rounded-lg bg-magenta-wash px-3 py-2 text-sm text-magenta">
          {summary.refundFailed} {summary.refundFailed === 1 ? 'refund' : 'refunds'} could not be
          sent automatically. Please send them from your Razorpay dashboard.
        </p>
      )}
    </section>
  );
}
