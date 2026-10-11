import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../components/ui';

/** Where someone lands without a shop link. Most people arrive by scanning the shop's QR code instead. */
export function HomePage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const open = (e: FormEvent) => {
    e.preventDefault();
    // Accept a pasted link or just the shop code.
    const match = code.trim().match(/\/s\/([a-z0-9-]+)/i);
    const slug = (match?.[1] ?? code.trim()).toLowerCase();
    if (slug) navigate(`/s/${slug}`);
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <h1 className="display text-4xl">Skip the print shop queue</h1>
      <p className="mt-4 text-muted">
        Upload your file, choose how it should print, and get a queue number. The shop prints it
        when you arrive.
      </p>
      <form onSubmit={open} className="mt-8 space-y-3">
        <label className="block">
          <span className="text-sm font-medium">Shop code or link</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. bms-college-prints"
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-1.5 min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
          />
        </label>
        <Button type="submit" className="w-full" disabled={!code.trim()}>
          Open shop
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        Tip: scanning the QR code at the shop opens it directly.
      </p>
    </main>
  );
}
