import { useState } from 'react';
import type { AdminShop } from '@print/contracts';
import { Button, Notice } from '../../components/ui';
import { adminApi } from '../../lib/admin-api';
import { ApiError } from '../../lib/api';
import { formatBytes, formatRupees } from '../../lib/format';

const MB = 1024 ** 2;

function Check({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span className={ok ? 'text-ok' : 'text-muted'}>
      {ok ? '✓' : '○'} {children}
    </span>
  );
}

export function ShopCard({
  shop,
  onChange,
  onOpen,
}: {
  shop: AdminShop;
  onChange: (s: AdminShop) => void;
  /** Opens the full page for this shop; omitted when already on it. */
  onOpen?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [quotaMb, setQuotaMb] = useState(
    shop.storageQuotaBytes === null ? '' : String(Math.round(shop.storageQuotaBytes / MB)),
  );

  const run = async (work: () => Promise<AdminShop>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await work());
      setSuspending(false);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const saveLimits = () => {
    const mb = quotaMb.trim() === '' ? null : Number(quotaMb);
    if (mb !== null && (!Number.isFinite(mb) || mb <= 0)) {
      setError('Enter a number of MB, or leave it empty for no cap.');
      return;
    }
    return run(() =>
      adminApi.setLimits(shop.id, { storageQuotaBytes: mb === null ? null : Math.round(mb * MB) }),
    );
  };

  return (
    <article className="rounded-card border border-line bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{shop.name}</h2>
          <p className="font-mono text-xs text-muted">/s/{shop.slug}</p>
        </div>
        <p className="font-mono text-xs uppercase text-muted">
          Applied {new Date(shop.createdAt).toLocaleDateString()}
        </p>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">Owner: </dt>
          <dd className="inline">
            {shop.owner ? `${shop.owner.name} (${shop.owner.email})` : '—'}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">Phone: </dt>
          <dd className="inline">{shop.contactPhone ?? '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline text-muted">Address: </dt>
          <dd className="inline">{shop.address ?? '—'}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Storage: </dt>
          <dd className="inline">
            {shop.storageBytes === 0 ? '0 KB' : formatBytes(shop.storageBytes)}
            {shop.storageQuotaBytes !== null ? ` of ${formatBytes(shop.storageQuotaBytes)}` : ''}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">Orders: </dt>
          <dd className="inline">
            {shop.openOrders} open · {shop.totalOrders} total
          </dd>
        </div>
      </dl>
      <p className="mt-3 flex flex-wrap gap-x-5 text-sm">
        <Check ok={shop.ratesSet}>Prices set</Check>
        <Check ok={shop.printingPaired}>Printing app linked</Check>
        <Check ok={shop.onlinePayments.enabled}>
          {shop.onlinePayments.enabled
            ? `Online payments (${shop.onlinePayments.mode === 'live' ? 'live' : 'test'})`
            : 'Online payments off'}
        </Check>
        {shop.printingPaired && (
          <Check ok={shop.printingOnline}>{shop.printingOnline ? 'Online now' : 'Offline'}</Check>
        )}
        <Check ok={shop.flags.officeFiles}>Word/Excel/PowerPoint on</Check>
      </p>

      {shop.status !== 'pending_approval' && (
        <p className="mt-3 rounded-xl bg-paper px-3 py-2 text-sm">
          <span className="text-muted">Last 30 days: </span>
          {shop.stats30.orders} orders · {shop.stats30.pages} pages ·{' '}
          {formatRupees(shop.stats30.collectedPaise)} collected
          {shop.stats30.refundFailed > 0 && (
            <span className="text-magenta"> · {shop.stats30.refundFailed} refund(s) failed</span>
          )}
        </p>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {suspending && (
        <div className="mt-3 space-y-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (kept in the activity log)"
            maxLength={300}
            className="min-h-11 w-full rounded-xl border border-line bg-white px-3 text-base"
          />
          <p className="text-sm text-muted">
            The owner is signed out of the queue, the printing app is disconnected and students can
            no longer use the shop.
          </p>
        </div>
      )}

      {editing && (
        <div className="mt-3 space-y-3 rounded-xl bg-paper p-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Storage cap for this shop (MB, empty = none)</span>
            <input
              inputMode="numeric"
              value={quotaMb}
              onChange={(e) => setQuotaMb(e.target.value)}
              className="min-h-11 w-28 rounded-xl border border-line bg-white px-3 text-right"
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={shop.flags.officeFiles}
              disabled={busy}
              onChange={(e) =>
                void run(() =>
                  adminApi.setLimits(shop.id, { flags: { officeFiles: e.target.checked } }),
                )
              }
            />
            Accept Word, Excel and PowerPoint files
          </label>
          <Button
            className="min-h-10 px-4 text-sm"
            onClick={() => void saveLimits()}
            disabled={busy}
          >
            Save cap
          </Button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {shop.status === 'pending_approval' && (
          <Button
            className="min-h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void run(() => adminApi.approve(shop.id))}
          >
            Approve
          </Button>
        )}
        {shop.status === 'suspended' && (
          <Button
            className="min-h-10 px-4 text-sm"
            disabled={busy}
            onClick={() => void run(() => adminApi.reactivate(shop.id))}
          >
            Reactivate
          </Button>
        )}
        {shop.status !== 'suspended' &&
          (suspending ? (
            <>
              <Button
                variant="danger"
                className="min-h-10 px-4 text-sm"
                disabled={busy}
                onClick={() => void run(() => adminApi.suspend(shop.id, reason))}
              >
                Confirm suspend
              </Button>
              <Button
                variant="ghost"
                className="min-h-10 px-4 text-sm"
                onClick={() => setSuspending(false)}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="danger"
              className="min-h-10 px-4 text-sm"
              onClick={() => setSuspending(true)}
            >
              {shop.status === 'pending_approval' ? 'Reject' : 'Suspend'}
            </Button>
          ))}
        <Button
          variant="secondary"
          className="min-h-10 px-4 text-sm"
          onClick={() => setEditing((v) => !v)}
        >
          Limits
        </Button>
        {onOpen && (
          <Button variant="ghost" className="min-h-10 px-4 text-sm" onClick={onOpen}>
            Details
          </Button>
        )}
      </div>
    </article>
  );
}
