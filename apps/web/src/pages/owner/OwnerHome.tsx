import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ShopSummary } from '@print/contracts';
import { Button, Notice, Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { isUnauthenticated, ownerApi } from '../../lib/owner-api';

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'shops'; shops: ShopSummary[] }
  | { kind: 'error'; message: string };

/** Where the shop owner arrives: sign in, then go straight to the queue (or pick a shop). */
export function OwnerHome() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = async () => {
    try {
      const { shops } = await ownerApi.shops();
      const usable = shops.filter((s) => s.status !== 'suspended');
      if (usable.length === 1) {
        navigate(`/owner/${usable[0]!.id}`, { replace: true });
        return;
      }
      setState({ kind: 'shops', shops });
    } catch (err) {
      setState(
        isUnauthenticated(err)
          ? { kind: 'signed-out' }
          : { kind: 'error', message: err instanceof ApiError ? err.message : 'Could not load.' },
      );
    }
  };

  useEffect(() => {
    document.title = 'Shop sign-in · Print';
    void load();
  }, []);

  if (state.kind === 'loading') {
    return (
      <Shell>
        <Spinner label="Loading" />
      </Shell>
    );
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <Notice tone="error">{state.message}</Notice>
      </Shell>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <Shell>
        <SignIn onDone={() => void load()} />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="display text-3xl">Your shops</h1>
      {state.shops.length === 0 ? (
        <p className="mt-4 text-muted">This account is not linked to a shop yet.</p>
      ) : (
        <ul className="mt-5 space-y-3">
          {state.shops.map((shop) => (
            <li key={shop.id}>
              {shop.status === 'suspended' ? (
                <p className="rounded-card border border-line bg-card p-4 text-muted">
                  {shop.name} is suspended.
                </p>
              ) : (
                <Link
                  to={`/owner/${shop.id}`}
                  className="block rounded-card border border-line bg-card p-4 font-semibold hover:border-ink"
                >
                  {shop.name}
                  <span className="ml-2 font-mono text-xs font-normal uppercase text-muted">
                    {shop.role}
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        className="mt-6"
        onClick={() => void ownerApi.logout().then(() => setState({ kind: 'signed-out' }))}
      >
        Sign out
      </Button>
    </Shell>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ownerApi.login(email, password);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <h1 className="display text-3xl">Shop sign-in</h1>
      <label className="block">
        <span className="text-sm font-medium">Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          className="mt-1.5 min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          className="mt-1.5 min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
        />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" className="w-full" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-md px-4 py-10">{children}</main>;
}
