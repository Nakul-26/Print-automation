import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AdminAuditEntry, AdminSettings, AdminShop } from '@print/contracts';
import { SignInForm } from '../../components/SignInForm';
import { Button, Notice, Spinner } from '../../components/ui';
import { adminApi } from '../../lib/admin-api';
import { ApiError } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { isUnauthenticated, ownerApi } from '../../lib/owner-api';

type Tab = 'pending_approval' | 'active' | 'suspended' | 'settings' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'pending_approval', label: 'Waiting' },
  { key: 'active', label: 'Active' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'settings', label: 'Limits' },
  { key: 'activity', label: 'Activity' },
];
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const gbText = (bytes: number) => `${(bytes / GB).toFixed(bytes < GB ? 2 : 1)} GB`;

type Access = 'loading' | 'signed-out' | 'forbidden' | 'ok';

/** The platform admin's panel: approve shops, suspend them, and set storage limits. */
export function AdminPage() {
  const [access, setAccess] = useState<Access>('loading');

  const check = useCallback(async () => {
    try {
      const { user } = await ownerApi.me();
      setAccess(user.platformRole === 'platform_admin' ? 'ok' : 'forbidden');
    } catch (err) {
      setAccess(isUnauthenticated(err) ? 'signed-out' : 'forbidden');
    }
  }, []);

  useEffect(() => {
    document.title = 'Admin · Print';
    void check();
  }, [check]);

  if (access === 'loading') {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-10">
        <Spinner label="Loading" />
      </main>
    );
  }
  if (access === 'signed-out') {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-10">
        <SignInForm title="Admin sign-in" onDone={() => void check()} />
      </main>
    );
  }
  if (access === 'forbidden') {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-10">
        <h1 className="display text-3xl">Not allowed</h1>
        <p className="mt-3 text-muted">This account is not a platform admin.</p>
        <Link to="/owner" className="mt-4 block font-medium text-cyan underline">
          Go to your shop
        </Link>
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => void ownerApi.logout().then(() => setAccess('signed-out'))}
        >
          Sign in as someone else
        </Button>
      </main>
    );
  }
  return <Panel onSignOut={() => void ownerApi.logout().then(() => setAccess('signed-out'))} />;
}

function Panel({ onSignOut }: { onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>('pending_approval');
  const [shops, setShops] = useState<AdminShop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setShops(await adminApi.shops());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const replace = (updated: AdminShop) =>
    setShops((list) => list?.map((s) => (s.id === updated.id ? updated : s)) ?? list);
  const count = (status: string) => shops?.filter((s) => s.status === status).length ?? 0;
  const visible = shops?.filter((s) => s.status === tab) ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="display text-3xl">Platform admin</h1>
        <Button variant="ghost" className="min-h-10 px-4 text-sm" onClick={onSignOut}>
          Sign out
        </Button>
      </header>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label="Sections">
        {TABS.map((t) => (
          <Button
            key={t.key}
            variant={tab === t.key ? 'primary' : 'secondary'}
            className="min-h-10 px-4 text-sm"
            onClick={() => setTab(t.key)}
            aria-pressed={tab === t.key}
          >
            {t.label}
            {t.key === 'pending_approval' || t.key === 'active' || t.key === 'suspended'
              ? ` · ${count(t.key)}`
              : ''}
          </Button>
        ))}
      </nav>

      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {tab === 'settings' && <Settings />}
      {tab === 'activity' && <Activity shops={shops ?? []} />}
      {tab !== 'settings' && tab !== 'activity' && (
        <section className="mt-5 space-y-4">
          {!shops && !error && <Spinner label="Loading shops" />}
          {shops && visible.length === 0 && (
            <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-muted">
              {tab === 'pending_approval' ? 'No applications waiting.' : 'No shops here.'}
            </p>
          )}
          {visible.map((shop) => (
            <ShopCard key={shop.id} shop={shop} onChange={replace} />
          ))}
        </section>
      )}
    </main>
  );
}

function Check({ ok, children }: { ok: boolean; children: string }) {
  return (
    <span className={ok ? 'text-ok' : 'text-muted'}>
      {ok ? '✓' : '○'} {children}
    </span>
  );
}

function ShopCard({ shop, onChange }: { shop: AdminShop; onChange: (s: AdminShop) => void }) {
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
        <Check ok={shop.flags.officeFiles}>Word/Excel/PowerPoint on</Check>
      </p>

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
      </div>
    </article>
  );
}

function Settings() {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [gb, setGb] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adminApi
      .settings()
      .then((s) => {
        setSettings(s);
        setGb(String(+(s.storageMaxBytes / GB).toFixed(2)));
      })
      .catch((err) =>
        setMessage({
          tone: 'error',
          text: err instanceof ApiError ? err.message : 'Could not load.',
        }),
      );
  }, []);

  const save = async () => {
    const bytes = Math.round(Number(gb) * GB);
    if (!Number.isFinite(bytes) || bytes < 100 * MB) {
      setMessage({ tone: 'error', text: 'Enter at least 0.1 GB.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      setSettings(await adminApi.setStorageMax(bytes));
      setMessage({
        tone: 'ok',
        text: 'Saved. The new limit is already in use; no restart needed.',
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      });
    } finally {
      setBusy(false);
    }
  };

  const used = settings
    ? Math.min(100, (settings.storageUsedBytes / settings.storageMaxBytes) * 100)
    : 0;

  return (
    <section className="mt-5 rounded-card border border-line bg-card p-4">
      <h2 className="font-semibold">Storage limit for all shops</h2>
      <p className="mt-1 text-sm text-muted">
        Uploaded files are kept one day. When the limit is nearly reached, the oldest files are
        removed first.
      </p>
      {!settings && !message && <Spinner label="Loading" />}
      {settings && (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full bg-cyan" style={{ width: `${used}%` }} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {gbText(settings.storageUsedBytes)} used of {gbText(settings.storageMaxBytes)}
          </p>
          <label className="mt-4 flex items-center justify-between gap-3 text-sm">
            <span>Limit (GB)</span>
            <input
              inputMode="decimal"
              value={gb}
              onChange={(e) => setGb(e.target.value)}
              className="min-h-11 w-28 rounded-xl border border-line bg-white px-3 text-right"
            />
          </label>
          <p className="mt-1 text-xs text-muted">
            Server default: {gbText(settings.defaultStorageMaxBytes)}. Keep this below the free disk
            space of the server.
          </p>
          <Button className="mt-4" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save limit'}
          </Button>
        </>
      )}
      {message && (
        <div className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'shop.applied': 'Applied for a shop',
  'shop.approved': 'Shop approved',
  'shop.suspended': 'Shop suspended',
  'shop.reactivated': 'Shop reactivated',
  'shop.limits_changed': 'Shop limits changed',
  'platform.storage_limit_changed': 'Storage limit changed',
  'printing.agent_paired': 'Printing app linked',
  'printing.agent_removed': 'Printing app removed',
  'pricing.rates_updated': 'Prices changed',
};

function Activity({ shops }: { shops: AdminShop[] }) {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminApi
      .audit()
      .then(setEntries)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load.'));
  }, []);
  const nameOf = (id: string | null) => shops.find((s) => s.id === id)?.name ?? null;

  return (
    <section className="mt-5">
      {error && <Notice tone="error">{error}</Notice>}
      {!entries && !error && <Spinner label="Loading" />}
      <ul className="divide-y divide-line rounded-card border border-line bg-card">
        {entries?.map((e) => {
          const reason = typeof e.metadata?.['reason'] === 'string' ? e.metadata['reason'] : null;
          return (
            <li key={e.id} className="px-4 py-2.5 text-sm">
              <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
              {nameOf(e.shopId) && <span> · {nameOf(e.shopId)}</span>}
              {reason && <span className="text-muted"> · “{reason}”</span>}
              <span className="block font-mono text-xs text-muted">
                {new Date(e.at).toLocaleString()}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
