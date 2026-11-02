import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { ownerApi } from '../lib/owner-api';
import { AuthShell } from './AuthShell';
import { PasswordInput } from './PasswordInput';
import { Button, Notice } from './ui';

function MailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

const COPY = {
  shop: {
    title: 'Welcome back',
    subtitle: 'Sign in to see your queue, prices and printing.',
    badge: undefined,
  },
  admin: {
    title: 'Admin sign-in',
    subtitle: 'For the people who run the platform.',
    badge: 'Platform admin',
  },
} as const;

/** The whole sign-in page for shop owners and staff (`shop`) and for platform admins (`admin`). */
export function SignInForm({
  variant,
  onDone,
}: {
  variant: keyof typeof COPY;
  onDone: () => void;
}) {
  const copy = COPY[variant];
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
    <AuthShell
      {...(copy.badge ? { badge: copy.badge } : {})}
      title={copy.title}
      subtitle={copy.subtitle}
      footer={
        variant === 'shop' ? (
          <>
            <p>
              Opening a new shop?{' '}
              <Link to="/apply" className="font-medium text-cyan underline">
                Apply here
              </Link>
            </p>
            <p>
              Printing something?{' '}
              <Link to="/" className="font-medium text-cyan underline">
                Open a shop
              </Link>
            </p>
          </>
        ) : (
          <p>
            Running a shop?{' '}
            <Link to="/owner" className="font-medium text-cyan underline">
              Shop sign-in
            </Link>
          </p>
        )
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium">Email</span>
          <div className="relative mt-1.5">
            <span className="pointer-events-none absolute inset-y-0 left-0 grid w-11 place-items-center text-muted">
              <MailIcon />
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              required
              className="min-h-12 w-full rounded-xl border border-line bg-white py-0 pl-11 pr-4 text-base"
            />
          </div>
        </label>
        <label className="block">
          <span className="text-sm font-medium">Password</span>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            withLockIcon
          />
        </label>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" className="w-full" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthShell>
  );
}
