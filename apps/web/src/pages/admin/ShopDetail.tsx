import { useEffect, useState } from 'react';
import type { AdminAuditEntry, AdminShop, AdminShopDetail } from '@print/contracts';
import { Button, Notice, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/admin-api';
import { ApiError } from '../../lib/api';
import { formatRupees, paymentMethodLabel } from '../../lib/format';
import { DailyBars, MethodSplit, Tile, ago } from './parts';
import { ShopCard } from './ShopCard';

const ACTION_LABEL: Record<string, string> = {
  'shop.applied': 'Applied for a shop',
  'shop.approved': 'Shop approved',
  'shop.suspended': 'Shop suspended',
  'shop.reactivated': 'Shop reactivated',
  'shop.limits_changed': 'Shop limits changed',
  'shop.notes_updated': 'Admin notes updated',
  'printing.agent_paired': 'Printing app linked',
  'printing.agent_removed': 'Printing app removed',
  'pricing.rates_updated': 'Prices changed',
};

const STATUS_TEXT = {
  draft: 'Draft',
  completed: 'Printed',
  rejected: 'Rejected',
  pending: 'Waiting',
  accepted: 'Accepted',
  printing: 'Printing',
  processing: 'Preparing',
  failed: 'Failed',
  expired: 'Expired',
} as const;

/** One shop in depth: numbers, trends, payments, latest orders, private notes and its history. */
export function ShopDetailView({
  shopId,
  onBack,
  onChange,
}: {
  shopId: string;
  onBack: () => void;
  onChange: (shop: AdminShop) => void;
}) {
  const [detail, setDetail] = useState<AdminShopDetail | null>(null);
  const [history, setHistory] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    adminApi
      .detail(shopId)
      .then(setDetail)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.'));

  useEffect(() => {
    void load();
    adminApi
      .audit(shopId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [shopId]);

  const updated = (shop: AdminShop) => {
    setDetail((d) => (d ? { ...d, shop } : d));
    onChange(shop);
    void load();
  };

  return (
    <div className="mt-4">
      <Button variant="ghost" className="-ml-3 min-h-10 px-3 text-sm" onClick={onBack}>
        ← All shops
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {!detail && !error && <Spinner label="Loading the shop" />}
      {detail && (
        <div className="mt-2 space-y-6">
          <ShopCard shop={detail.shop} onChange={updated} />

          <section aria-label="Last 30 days" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Orders" value={String(detail.shop.stats30.orders)} hint="last 30 days" />
            <Tile label="Printed" value={String(detail.shop.stats30.printed)} hint="orders" />
            <Tile label="Pages" value={String(detail.shop.stats30.pages)} hint="printed sides" />
            <Tile
              label="Paid online"
              value={formatRupees(detail.shop.stats30.collectedPaise)}
              hint={`paid online${
                detail.shop.stats30.counterCount > 0
                  ? ` · ${detail.shop.stats30.counterCount} at the counter`
                  : ''
              }`}
            />
          </section>

          <section className="grid gap-4 sm:grid-cols-2" aria-label="Trends">
            <DailyBars days={detail.daily} metric="orders" />
            <DailyBars days={detail.daily} metric="collectedPaise" />
          </section>

          <section className="rounded-card border border-line bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">How students paid</h2>
            <MethodSplit rows={detail.byMethod} />
          </section>

          <NotesBox shop={detail.shop} onSaved={updated} />

          <section aria-labelledby="recent-h">
            <h2 id="recent-h" className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
              Latest orders
            </h2>
            {detail.recent.length === 0 ? (
              <p className="rounded-card border border-dashed border-line px-4 py-5 text-center text-sm text-muted">
                No orders yet.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-card border border-line bg-card text-sm">
                {detail.recent.map((o) => (
                  <li
                    key={`${o.queueNumber}-${o.createdAt}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <span>
                      <span className="font-mono font-medium">{o.queueNumber}</span>
                      <span className="text-muted"> · {STATUS_TEXT[o.status]}</span>
                      {o.paymentMethod && (
                        <span className="text-muted"> · {paymentMethodLabel(o.paymentMethod)}</span>
                      )}
                      <span className="block font-mono text-xs text-muted">{ago(o.createdAt)}</span>
                    </span>
                    <span className="font-mono">{formatRupees(o.amountPaise)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted">Student names are never shown here.</p>
          </section>

          <section aria-labelledby="history-h">
            <h2
              id="history-h"
              className="mb-2 font-mono text-xs uppercase tracking-wide text-muted"
            >
              History
            </h2>
            {!history && <Spinner label="Loading" />}
            {history && history.length === 0 && (
              <p className="text-sm text-muted">Nothing recorded yet.</p>
            )}
            {history && history.length > 0 && (
              <ul className="divide-y divide-line rounded-card border border-line bg-card">
                {history.map((e) => {
                  const reason =
                    typeof e.metadata?.['reason'] === 'string' ? e.metadata['reason'] : null;
                  return (
                    <li key={e.id} className="px-4 py-2.5 text-sm">
                      <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                      {reason && <span className="text-muted"> · “{reason}”</span>}
                      <span className="block font-mono text-xs text-muted">
                        {new Date(e.at).toLocaleString()}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** Private notes for the platform admin. The shop never sees them. */
function NotesBox({ shop, onSaved }: { shop: AdminShop; onSaved: (s: AdminShop) => void }) {
  const [text, setText] = useState(shop.adminNotes);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const changed = text.trim() !== shop.adminNotes;

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(await adminApi.setNotes(shop.id, text.trim()));
      setMessage({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-card border border-line bg-card p-4">
      <label htmlFor="admin-notes" className="text-sm font-medium">
        Private notes
      </label>
      <p className="text-xs text-muted">Only platform admins can see these.</p>
      <textarea
        id="admin-notes"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        rows={4}
        placeholder="Owner contact preferences, agreements, issues to follow up…"
        className="mt-2 w-full rounded-xl border border-line bg-white px-3 py-2 text-base"
      />
      <div className="mt-2 flex items-center gap-3">
        <Button
          className="min-h-10 px-4 text-sm"
          disabled={busy || !changed}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save notes'}
        </Button>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
      </div>
    </section>
  );
}
