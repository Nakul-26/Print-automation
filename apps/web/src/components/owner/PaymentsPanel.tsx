import { useEffect, useState, type FormEvent } from 'react';
import type { PaymentSettingsView } from '@print/contracts';
import { ApiError } from '../../lib/api';
import { paymentsApi } from '../../lib/owner-api';
import { PasswordInput } from '../PasswordInput';
import { Button, Notice, Spinner } from '../ui';

const FIELD = 'mt-1.5 min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base';

/** Where the shop connects its own Razorpay account so students can pay on the website. Owner only. */
export function PaymentsPanel({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const [view, setView] = useState<PaymentSettingsView | null>(null);
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const fail = (err: unknown) =>
    setMessage({
      tone: 'error',
      text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
    });

  useEffect(() => {
    paymentsApi.get(shopId).then(setView).catch(fail);
  }, [shopId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (work: () => Promise<PaymentSettingsView>, success?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      setView(await work());
      if (success) setMessage({ tone: 'ok', text: success });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const saved = await paymentsApi.saveKeys(shopId, {
        keyId: keyId.trim(),
        keySecret: keySecret.trim(),
        enabled: true,
      });
      setKeyId('');
      setKeySecret('');
      setReplacing(false);
      return saved;
    }, 'Connected. Students can now pay online at your shop.');
  };

  const showForm = view !== null && (!view.configured || replacing);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Online payments"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/60 p-3"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-lg rounded-card bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="display text-2xl">Online payments</h2>
          <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Let students pay on the website with UPI, cards or net banking. The money goes straight to
          your own Razorpay account and bank. Students can still choose to pay at the counter.
        </p>

        {!view && !message && <Spinner label="Loading" />}

        {view?.configured && !replacing && (
          <div className="mt-4 rounded-xl border border-line bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">
                  Razorpay connected
                  <span
                    className={`ml-2 rounded-md px-2 py-0.5 font-mono text-xs uppercase ${
                      view.mode === 'live' ? 'bg-ok-wash text-ok' : 'bg-slip text-ink'
                    }`}
                  >
                    {view.mode === 'live' ? 'Live' : 'Test mode'}
                  </span>
                </p>
                <p className="break-all font-mono text-xs text-muted">{view.keyId}</p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={view.enabled}
                  disabled={busy}
                  onChange={(e) => void run(() => paymentsApi.setEnabled(shopId, e.target.checked))}
                  className="size-5"
                />
                Accept online payments
              </label>
            </div>
            {view.mode === 'test' && (
              <p className="mt-3 rounded-lg bg-slip px-3 py-2 text-sm">
                You are using <b>test keys</b>: nobody is really charged. Use this to try the whole
                flow, then connect your live keys when you are ready.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <button
                type="button"
                className="font-medium text-cyan underline"
                onClick={() => setReplacing(true)}
              >
                Change keys
              </button>
              {!confirmRemove ? (
                <button
                  type="button"
                  className="font-medium text-magenta underline"
                  onClick={() => setConfirmRemove(true)}
                >
                  Disconnect
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-muted">Stop taking online payments?</span>
                  <Button
                    variant="danger"
                    className="min-h-9 px-3 text-sm"
                    disabled={busy}
                    onClick={() => {
                      setConfirmRemove(false);
                      void run(() => paymentsApi.remove(shopId), 'Disconnected.');
                    }}
                  >
                    Disconnect
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-9 px-3 text-sm"
                    onClick={() => setConfirmRemove(false)}
                  >
                    Keep
                  </Button>
                </span>
              )}
            </div>
          </div>
        )}

        {showForm && (
          <form onSubmit={save} className="mt-4 space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>
                Make a free account at{' '}
                <a
                  href="https://dashboard.razorpay.com/signup"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-cyan underline"
                >
                  razorpay.com
                </a>{' '}
                (there is no setup fee; check Razorpay&apos;s current charges).
              </li>
              <li>
                In the dashboard open <b>Account &amp; Settings → API Keys</b> and generate a key.
                Start with a <b>Test</b> key to try it without real money.
              </li>
              <li>Paste the Key ID and Key Secret below. The secret is stored encrypted.</li>
            </ol>
            <label className="block">
              <span className="text-sm font-medium">Key ID</span>
              <input
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="rzp_test_…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                required
                className={`${FIELD} font-mono`}
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Key Secret</span>
              <PasswordInput
                value={keySecret}
                onChange={(e) => setKeySecret(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <div className="flex gap-3">
              <Button type="submit" className="flex-1" disabled={busy || !keyId || !keySecret}>
                {busy ? 'Checking the keys…' : 'Save and connect'}
              </Button>
              {replacing && (
                <Button type="button" variant="ghost" onClick={() => setReplacing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        )}

        {message && (
          <div className="mt-4">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}

        <p className="mt-5 text-xs text-muted">
          If you reject an order that was paid online, the student is refunded automatically from
          your Razorpay account. Keep a little balance there to cover refunds.
        </p>
      </div>
    </div>
  );
}
