import type { AdminDaily, PaymentTotals } from '@print/contracts';
import { PAYMENT_LABEL, formatRupees } from '../../lib/format';

/** One headline number with a small label. */
export function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-card p-4">
      <p className="display break-words text-2xl">{value}</p>
      <p className="mt-1 font-mono text-xs uppercase tracking-wide text-muted">{label}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

const METRIC = {
  orders: { label: 'Orders per day', pick: (d: AdminDaily) => d.orders, text: String },
  pages: { label: 'Pages printed per day', pick: (d: AdminDaily) => d.pages, text: String },
  collectedPaise: {
    label: 'Money collected per day',
    pick: (d: AdminDaily) => d.collectedPaise,
    text: formatRupees,
  },
} as const;

/** The last N days as bars. Plain divs, so it needs no chart library and reads well in a screen reader. */
export function DailyBars({ days, metric }: { days: AdminDaily[]; metric: keyof typeof METRIC }) {
  const m = METRIC[metric];
  const values = days.map(m.pick);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <figure className="rounded-card border border-line bg-card p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{m.label}</span>
        <span className="font-mono text-xs text-muted">
          {days.length} days · {m.text(total)} total
        </span>
      </figcaption>
      <div
        className="mt-3 flex h-24 items-end gap-0.5"
        role="img"
        aria-label={`${m.label}, last ${days.length} days, ${m.text(total)} in total`}
      >
        {days.map((d, i) => {
          const v = values[i] ?? 0;
          return (
            <div
              key={d.date}
              title={`${d.date}: ${m.text(v)}`}
              className={`min-w-0 flex-1 rounded-sm ${v > 0 ? 'bg-cyan' : 'bg-line'}`}
              style={{ height: v > 0 ? `${Math.max(6, (v / max) * 100)}%` : '3px' }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
        <span>{days[0]?.date.slice(5)}</span>
        <span>{days[days.length - 1]?.date.slice(5)}</span>
      </div>
    </figure>
  );
}

/** How the money was paid, as a bar split and a legend. */
export function MethodSplit({ rows }: { rows: PaymentTotals[] }) {
  const total = rows.reduce((a, r) => a + r.amountPaise, 0);
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No payments recorded yet.</p>;
  }
  const tone = { cash: 'bg-ink', upi: 'bg-cyan', card: 'bg-magenta' } as const;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-line" aria-hidden>
        {rows.map((r) => (
          <div
            key={r.method}
            className={tone[r.method]}
            style={{ width: `${total ? (r.amountPaise / total) * 100 : 0}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.method}>
            <span className={`mr-1.5 inline-block size-2.5 rounded-full ${tone[r.method]}`} />
            {PAYMENT_LABEL[r.method]} {formatRupees(r.amountPaise)}{' '}
            <span className="text-muted">({r.count})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "3 h ago", "2 days ago": coarse, for "last order". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

export function PrintingDot({ paired, online }: { paired: boolean; online: boolean }) {
  const [tone, text] = !paired
    ? ['bg-line', 'Not linked']
    : online
      ? ['bg-ok', 'Online']
      : ['bg-magenta', 'Offline'];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block size-2.5 rounded-full ${tone}`} aria-hidden />
      {text}
    </span>
  );
}
