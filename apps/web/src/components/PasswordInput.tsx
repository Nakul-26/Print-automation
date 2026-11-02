import { useState, type ChangeEvent } from 'react';

const ICON = {
  viewBox: '0 0 24 24',
  width: 22,
  height: 22,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg {...ICON}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg {...ICON} width={20} height={20}>
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}

/** A password box with an eye button that shows or hides what was typed. */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  required,
  minLength,
  withLockIcon,
}: {
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  autoComplete: 'current-password' | 'new-password';
  required?: boolean;
  minLength?: number;
  /** Shows a small lock at the start, to match fields that have an icon. */
  withLockIcon?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative mt-1.5">
      {withLockIcon && (
        <span className="pointer-events-none absolute inset-y-0 left-0 grid w-11 place-items-center text-muted">
          <LockIcon />
        </span>
      )}
      <input
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        autoCapitalize="none"
        spellCheck={false}
        className={`min-h-12 w-full rounded-xl border border-line bg-white py-0 pr-12 text-base ${
          withLockIcon ? 'pl-11' : 'pl-4'
        }`}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        className="absolute inset-y-0 right-0 grid w-12 place-items-center rounded-r-xl text-muted hover:text-ink"
      >
        <EyeIcon off={shown} />
      </button>
    </div>
  );
}
