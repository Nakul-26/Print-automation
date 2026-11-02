import type { ReactNode } from 'react';

function PrinterMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 9V3h10v6" />
      <rect x="3" y="9" width="18" height="9" rx="2" />
      <path d="M7 14h10v7H7z" fill="var(--color-card)" />
    </svg>
  );
}

/**
 * The frame for pages where someone signs in: a card in the middle of the screen with the brand on
 * top. Keeps the shop and admin sign-in pages looking like one product.
 */
export function AuthShell({
  badge,
  title,
  subtitle,
  children,
  footer,
}: {
  /** A small label above the title, such as "Platform admin". */
  badge?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      className="grid min-h-dvh place-items-center px-4 py-10"
      style={{
        backgroundImage:
          'radial-gradient(60rem 28rem at 50% -8rem, var(--color-cyan-wash), transparent 70%)',
      }}
    >
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-cyan text-white shadow-sm">
            <PrinterMark />
          </span>
          <span className="display text-2xl" style={{ fontStretch: '125%' }}>
            Print
          </span>
        </div>

        <section className="rounded-[20px] border border-line bg-card p-6 shadow-[0_1px_2px_rgba(17,21,26,0.04),0_18px_44px_-18px_rgba(7,86,109,0.28)] sm:p-8">
          {badge && (
            <p className="mb-3 inline-block rounded-full bg-cyan-wash px-3 py-1 font-mono text-xs font-medium uppercase tracking-wide text-cyan-deep">
              {badge}
            </p>
          )}
          <h1 className="display text-3xl">{title}</h1>
          {subtitle && <p className="mt-2 text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>

        {footer && <div className="mt-5 space-y-1.5 text-center text-sm text-muted">{footer}</div>}
      </div>
    </main>
  );
}
