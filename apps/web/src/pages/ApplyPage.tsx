import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Turnstile } from '../components/Turnstile';
import { Button, Notice } from '../components/ui';
import { applyApi } from '../lib/admin-api';
import { ApiError } from '../lib/api';

const FIELD = 'mt-1.5 min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base';

function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Where a print shop owner applies. The platform admin approves the shop before students can use it. */
export function ApplyPage() {
  const [form, setForm] = useState({
    shopName: '',
    slug: '',
    ownerName: '',
    email: '',
    password: '',
    phone: '',
    address: '',
  });
  const [slugEdited, setSlugEdited] = useState(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [botToken, setBotToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    document.title = 'Apply for a shop · Print';
    applyApi
      .config()
      .then((c) => setSiteKey(c.turnstileSiteKey))
      .catch(() => undefined);
  }, []);

  const onToken = useCallback((token: string | null) => setBotToken(token), []);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({
      ...f,
      [key]: e.target.value,
      ...(key === 'shopName' && !slugEdited ? { slug: slugFrom(e.target.value) } : {}),
    }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await applyApi.apply({ ...form, ...(botToken ? { botToken } : {}) });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not send your application. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="mx-auto w-full max-w-md px-4 py-10">
        <h1 className="display text-3xl">Application received</h1>
        <p className="mt-4 text-muted">
          Thank you. We will check your details and approve your shop. You can already sign in to
          set your prices and connect your printers. Students can use your shop once it is approved.
        </p>
        <Link
          to="/owner"
          className="mt-6 inline-flex min-h-12 items-center rounded-xl bg-cyan px-5 font-semibold text-white"
        >
          Sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="display text-3xl">Apply for your print shop</h1>
      <p className="mt-3 text-muted">
        Students scan your QR code, upload their file and get a queue number. You only press Print
        or Reject.
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Shop name</span>
          <input
            value={form.shopName}
            onChange={set('shopName')}
            required
            minLength={2}
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Shop link</span>
          <div className="mt-1.5 flex items-center gap-2 text-sm text-muted">
            <span>{window.location.host}/s/</span>
            <input
              value={form.slug}
              onChange={(e) => {
                setSlugEdited(true);
                set('slug')(e);
              }}
              required
              minLength={3}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lowercase letters, numbers and dashes"
              autoCapitalize="none"
              className="min-h-12 w-full rounded-xl border border-line bg-white px-3 text-base text-ink"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Shop address</span>
          <input
            value={form.address}
            onChange={set('address')}
            required
            minLength={5}
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Shop phone</span>
          <input
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            required
            minLength={7}
            className={FIELD}
          />
        </label>
        <hr className="border-line" />
        <label className="block">
          <span className="text-sm font-medium">Your name</span>
          <input
            value={form.ownerName}
            onChange={set('ownerName')}
            required
            minLength={2}
            autoComplete="name"
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Email (you sign in with this)</span>
          <input
            type="email"
            value={form.email}
            onChange={set('email')}
            required
            autoComplete="username"
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password (at least 10 characters)</span>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={10}
            autoComplete="new-password"
            className={FIELD}
          />
        </label>
        <Turnstile siteKey={siteKey} onToken={onToken} />
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" className="w-full" disabled={busy || (siteKey !== null && !botToken)}>
          {busy ? 'Sending…' : 'Send application'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Already have an account?{' '}
        <Link to="/owner" className="font-medium text-cyan underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
