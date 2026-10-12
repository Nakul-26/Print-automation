import { useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api';
import { ownerApi } from '../lib/owner-api';
import { Button, Notice } from './ui';

/** Email and password sign-in, shared by the shop owner and platform admin pages. */
export function SignInForm({ title, onDone }: { title: string; onDone: () => void }) {
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
      <h1 className="display text-3xl">{title}</h1>
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
