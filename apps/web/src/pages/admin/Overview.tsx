import { useEffect, useState } from 'react';
import type { AdminOverview, AdminShop } from '@print/contracts';
import { Notice, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/admin-api';
import { ApiError } from '../../lib/api';
import { formatRupees } from '../../lib/format';
import { DailyBars, MethodSplit, PrintingDot, Tile, ago } from './parts';

const KIND_LABEL = {
  waiting_approval: 'Waiting for approval',
  printing_offline: 'Printing app offline',
  refund_failed: 'Refund needs attention',
  storage_near_cap: 'Storage nearly full',
  no_orders: 'No recent orders',
} as const;

const STATUS_LABEL = {
  pending_approval: 'Waiting',
  active: 'Active',
  suspended: 'Suspended',
} as const;

/** The platform at a glance, with every shop in one table. */
export function Overview({
  shops,
  onOpenShop,
}: {
  shops: AdminShop[];
  onOpenShop: (shopId: string) => void;
}) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .overview()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.'));
  }, []);

  if (error) {
    return (
      <div className="mt-5">
        <Notice tone="error">{error}</Notice>
      </div>
    );
  }
  if (!data) return <Spinner label="Loading the overview" />;

  // Busiest first, so the shops that matter most are on top; shops without orders sink.
  const sorted = [...shops].sort(
    (a, b) =>
      b.stats30.collectedPaise - a.stats30.collectedPaise ||
      b.stats30.orders - a.stats30.orders ||
      a.name.localeCompare(b.name),
  );

  return (
    <div className="mt-5 space-y-6">
      <section
        aria-label="Today and the last 30 days"
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
      >
        <Tile label="Collected today" value={formatRupees(data.today.collectedPaise)} />
        <Tile
          label="Orders today"
          value={String(data.today.orders)}
          hint={`${data.today.pages} pages`}
        />
        <Tile label="Collected, 30 days" value={formatRupees(data.last30.collectedPaise)} />
        <Tile
          label="Orders, 30 days"
          value={String(data.last30.orders)}
          hint={`${data.last30.pages} pages`}
        />
        <Tile
          label="Shops"
          value={String(data.shops.active)}
          hint={`${data.shops.pending} waiting · ${data.shops.suspended} suspended`}
        />
        <Tile
          label="Printing apps online"
          value={`${data.printingOnline}/${data.printingOnline + data.printingOffline}`}
          hint="Active shops with a linked app"
        />
      </section>

      <section aria-labelledby="attention-h">
        <h2 id="attention-h" className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
          Needs attention · {data.attention.length}
        </h2>
        {data.attention.length === 0 ? (
          <p className="rounded-card border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
            Nothing needs attention right now.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-card">
            {data.attention.map((a, i) => (
              <li key={`${a.shopId}-${a.kind}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOpenShop(a.shopId)}
                  className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left text-sm hover:bg-paper"
                >
                  <span>
                    <span className="font-medium">{a.shopName}</span>
                    <span className="text-muted"> · {KIND_LABEL[a.kind]}</span>
                  </span>
                  <span className="text-muted">{a.detail}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2" aria-label="Trends">
        <DailyBars days={data.daily} metric="orders" />
        <DailyBars days={data.daily} metric="collectedPaise" />
      </section>

      <section aria-labelledby="methods-h" className="rounded-card border border-line bg-card p-4">
        <h2 id="methods-h" className="mb-3 text-sm font-medium">
          How students paid, last 30 days
        </h2>
        <MethodSplit rows={data.byMethod30} />
      </section>

      <section aria-labelledby="shops-h">
        <h2 id="shops-h" className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
          All shops · {sorted.length}
        </h2>
        <div className="overflow-x-auto rounded-card border border-line bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="font-mono text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-normal">Shop</th>
                <th className="px-3 py-2 font-normal">Printing</th>
                <th className="px-3 py-2 text-right font-normal">Orders</th>
                <th className="px-3 py-2 text-right font-normal">Pages</th>
                <th className="px-3 py-2 text-right font-normal">Paid online</th>
                <th className="px-3 py-2 text-right font-normal">At counter</th>
                <th className="px-3 py-2 font-normal">Last order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((s) => (
                <tr key={s.id} className="hover:bg-paper">
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-left font-medium underline-offset-2 hover:underline"
                      onClick={() => onOpenShop(s.id)}
                    >
                      {s.name}
                    </button>
                    {s.status !== 'active' && (
                      <span className="ml-2 font-mono text-xs text-muted">
                        {STATUS_LABEL[s.status]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <PrintingDot paired={s.printingPaired} online={s.printingOnline} />
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{s.stats30.orders}</td>
                  <td className="px-3 py-2 text-right font-mono">{s.stats30.pages}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatRupees(s.stats30.collectedPaise)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-muted">
                    {s.stats30.counterCount}
                  </td>
                  <td className="px-3 py-2 text-muted">{ago(s.stats30.lastOrderAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Orders, pages and money are for the last 30 days. Pages are printed sides.
        </p>
      </section>
    </div>
  );
}
