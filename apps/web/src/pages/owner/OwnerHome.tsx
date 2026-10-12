import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ShopSummary } from '@print/contracts';
import { SignInForm } from '../../components/SignInForm';
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
        <SignInForm title="Shop sign-in" onDone={() => void load()} />
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
                    {shop.status === 'pending_approval' ? 'waiting for approval' : shop.role}
                  </span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-sm text-muted">
        Opening a new shop?{' '}
        <Link to="/apply" className="font-medium text-cyan underline">
          Apply here
        </Link>
        .
      </p>
      <Button
        variant="ghost"
        className="mt-2"
        onClick={() => void ownerApi.logout().then(() => setState({ kind: 'signed-out' }))}
      >
        Sign out
      </Button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-md px-4 py-10">{children}</main>;
}
