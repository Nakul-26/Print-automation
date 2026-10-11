import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-cyan text-white hover:bg-cyan-deep disabled:bg-line disabled:text-muted',
  secondary:
    'bg-card text-ink border border-line hover:border-ink disabled:text-muted disabled:hover:border-line',
  ghost: 'bg-transparent text-cyan hover:bg-cyan-wash disabled:text-muted',
  danger: 'bg-transparent text-magenta hover:bg-magenta-wash',
};

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-base font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    />
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-muted" role="status">
      <span
        className="size-4 animate-spin rounded-full border-2 border-line border-t-cyan"
        aria-hidden
      />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'ok';
  children: ReactNode;
}) {
  const style = {
    info: 'bg-cyan-wash text-cyan-deep',
    error: 'bg-magenta-wash text-magenta',
    ok: 'bg-ok-wash text-ok',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-xl px-4 py-3 text-sm leading-snug ${style}`}
    >
      {children}
    </p>
  );
}

/** A group of mutually exclusive choices; each option is a large touch target. */
export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium text-muted">{label}</legend>
      <div className="flex gap-1 rounded-xl bg-line/60 p-1" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={o.disabled}
              onClick={() => onChange(o.value)}
              className={`min-h-11 flex-1 rounded-lg px-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? 'bg-card text-ink shadow-sm ring-1 ring-ink/15'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex gap-1.5" aria-label="Progress">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'now' : 'next';
        return (
          <li
            key={label}
            className="min-w-0 flex-1"
            aria-current={state === 'now' ? 'step' : undefined}
          >
            <div
              className={`h-1.5 rounded-full ${state === 'next' ? 'bg-line' : 'bg-cyan'}`}
              aria-hidden
            />
            <p
              className={`mt-1.5 truncate font-mono text-xs uppercase tracking-wide ${
                state === 'now' ? 'font-medium text-ink' : 'text-muted'
              }`}
            >
              {label}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-card border border-line bg-card p-4 sm:p-5 ${className}`}>
      {children}
    </section>
  );
}
