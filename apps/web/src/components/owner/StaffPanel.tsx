import { useEffect, useState, type FormEvent } from 'react';
import type { StaffMember } from '@print/contracts';
import { ApiError } from '../../lib/api';
import { staffApi } from '../../lib/owner-api';
import { Button, Notice, Spinner } from '../ui';

/** A password that is shown once, with a copy button and the sign-in address to give the person. */
function PasswordCard({
  name,
  email,
  password,
  onDismiss,
}: {
  name: string;
  email: string;
  password: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const address = `${window.location.origin}/owner`;
  const message = `Sign in at ${address}\nEmail: ${email}\nPassword: ${password}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div role="status" className="mt-4 rounded-xl border border-cyan bg-white p-4">
      <p className="text-sm font-medium">Give {name} these sign-in details</p>
      <p className="mt-1 text-sm text-muted">
        This password is shown only now. Write it down or copy it before closing.
      </p>
      <dl className="mt-3 space-y-1 break-all font-mono text-sm">
        <div>
          <dt className="inline text-muted">Address: </dt>
          <dd className="inline">{address}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Email: </dt>
          <dd className="inline">{email}</dd>
        </div>
        <div>
          <dt className="inline text-muted">Password: </dt>
          <dd className="inline font-semibold">{password}</dd>
        </div>
      </dl>
      <div className="mt-3 flex gap-2">
        <Button className="min-h-10 px-4 text-sm" onClick={() => void copy()}>
          {copied ? 'Copied ✓' : 'Copy details'}
        </Button>
        <Button variant="ghost" className="min-h-10 px-4 text-sm" onClick={onDismiss}>
          I have saved it
        </Button>
      </div>
    </div>
  );
}

/** Who can sign in to this shop's queue. Only the owner sees this. */
export function StaffPanel({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [secret, setSecret] = useState<{ name: string; email: string; password: string } | null>(
    null,
  );
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const fail = (err: unknown) =>
    setMessage({
      tone: 'error',
      text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
    });

  const load = () => staffApi.list(shopId).then(setMembers).catch(fail);

  useEffect(() => {
    void load();
    // Reload only when the shop changes.
  }, [shopId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await staffApi.add(shopId, { name: name.trim(), email: email.trim() });
      setName('');
      setEmail('');
      if (res.password) {
        setSecret({ name: res.member.name, email: res.member.email, password: res.password });
      } else {
        setMessage({
          tone: 'ok',
          text: `${res.member.name} already had an account, so they can sign in with their own password.`,
        });
      }
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const reset = async (member: StaffMember) => {
    setBusy(true);
    setMessage(null);
    try {
      const password = await staffApi.resetPassword(shopId, member.userId);
      setSecret({ name: member.name, email: member.email, password });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: StaffMember) => {
    setBusy(true);
    setMessage(null);
    try {
      await staffApi.remove(shopId, member.userId);
      setConfirmRemove(null);
      setMessage({ tone: 'ok', text: `${member.name} can no longer sign in to your shop.` });
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Staff"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/60 p-3"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-lg rounded-card bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="display text-2xl">Staff</h2>
          <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Staff can see the queue and press Print, Reject and Paid. Only you can change prices,
          printers and staff.
        </p>

        {!members && !message && <Spinner label="Loading" />}
        {members && (
          <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-white">
            {members.map((m) => (
              <li key={m.userId} className="px-4 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {m.name}
                      <span className="ml-2 font-mono text-xs uppercase text-muted">
                        {m.role === 'owner' ? 'Owner' : 'Staff'}
                      </span>
                    </p>
                    <p className="break-all text-muted">{m.email}</p>
                  </div>
                  {m.role === 'staff' && confirmRemove !== m.userId && (
                    <div className="flex shrink-0 gap-3">
                      <button
                        type="button"
                        className="font-medium text-cyan underline disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void reset(m)}
                      >
                        New password
                      </button>
                      <button
                        type="button"
                        className="font-medium text-magenta underline disabled:opacity-50"
                        disabled={busy}
                        onClick={() => setConfirmRemove(m.userId)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                {confirmRemove === m.userId && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-muted">
                      Remove {m.name}? They are signed out at once.
                    </span>
                    <Button
                      variant="danger"
                      className="min-h-9 px-3 text-sm"
                      disabled={busy}
                      onClick={() => void remove(m)}
                    >
                      Remove
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-9 px-3 text-sm"
                      onClick={() => setConfirmRemove(null)}
                    >
                      Keep
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {secret && <PasswordCard {...secret} onDismiss={() => setSecret(null)} />}

        <form onSubmit={(e) => void add(e)} className="mt-5 space-y-3">
          <h3 className="text-sm font-medium">Add a staff member</h3>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={80}
            autoComplete="off"
            placeholder="Name"
            aria-label="Name"
            className="min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="off"
            placeholder="Email (they sign in with this)"
            aria-label="Email"
            className="min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
          />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Working…' : 'Add staff member'}
          </Button>
        </form>

        {message && (
          <div className="mt-3">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}
      </div>
    </div>
  );
}
