import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairingCode, PrinterChoice, PrintingStatus } from '@print/contracts';
import { ApiError } from '../../lib/api';
import { ownerApi } from '../../lib/owner-api';
import { timeAgo } from '../../lib/format';
import { Button, Notice, Spinner } from '../ui';

const POLL_MS = 3000;
const STORE_URL = import.meta.env['VITE_AGENT_STORE_URL'] as string | undefined;
const DOWNLOAD_URL = import.meta.env['VITE_AGENT_DOWNLOAD_URL'] as string | undefined;

const MODES = [
  { key: 'black_white', label: 'Black & white jobs' },
  { key: 'color', label: 'Colour jobs' },
] as const;

function describePrinter(p: PrintingStatus['printers'][number]): string {
  const bits = [
    p.isColor === true ? 'colour' : p.isColor === false ? 'black & white' : null,
    p.supportsDuplex === true ? '2-sided' : null,
    p.offline ? 'offline' : null,
  ].filter(Boolean);
  return bits.length > 0 ? `${p.name} (${bits.join(', ')})` : p.name;
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  if (left === 0) return <span>The code has expired. Get a new one.</span>;
  return (
    <span>
      Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  );
}

/** Sets up the shop's printing app: a pairing code, the printers it found, and a test page. */
export function PrintingPanel({
  shopId,
  canEdit,
  onClose,
  onStatus,
}: {
  shopId: string;
  canEdit: boolean;
  onClose: () => void;
  onStatus: (status: PrintingStatus) => void;
}) {
  const [status, setStatus] = useState<PrintingStatus | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [draft, setDraft] = useState<Record<'black_white' | 'color', PrinterChoice | null> | null>(
    null,
  );
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Choices the owner made by hand are never overwritten by what the server picked.
  const touched = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const next = await ownerApi.printing(shopId);
      setStatus(next);
      onStatus(next);
      // Keep what the owner is choosing; start the form from the saved assignment.
      setDraft(
        (current) =>
          current ?? {
            black_white: next.mapping.black_white && {
              printerName: next.mapping.black_white.printerName,
              supportsDuplex: next.mapping.black_white.supportsDuplex,
            },
            color: next.mapping.color && {
              printerName: next.mapping.color.printerName,
              supportsDuplex: next.mapping.color.supportsDuplex,
            },
          },
      );
      // Once the app has linked, the code is spent.
      if (next.agent) setCode(null);
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Could not load.',
      });
    }
  }, [shopId, onStatus]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // When the app reports printers the owner has not assigned yet, adopt what the server picked.
  useEffect(() => {
    if (!status) return;
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current };
      for (const { key } of MODES) {
        const saved = status.mapping[key];
        if (!next[key] && saved && !touched.current.has(key)) {
          next[key] = { printerName: saved.printerName, supportsDuplex: saved.supportsDuplex };
        }
      }
      return next;
    });
  }, [status]);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ tone: 'ok', text });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const getCode = () => run(async () => void setCode(await ownerApi.createPairingCode(shopId)));

  const changed =
    status && draft
      ? MODES.some(({ key }) => {
          const saved = status.mapping[key];
          const wanted = draft[key];
          return (
            saved?.printerName !== wanted?.printerName ||
            saved?.supportsDuplex !== wanted?.supportsDuplex
          );
        })
      : false;

  const save = () =>
    run(async () => {
      if (!draft) return;
      const next = await ownerApi.saveMapping(shopId, draft);
      setStatus(next);
      onStatus(next);
      return 'Saved.';
    });

  const agent = status?.agent ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Printing setup"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/60 p-3"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-lg rounded-card bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="display text-2xl">Printing</h2>
          <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={onClose}>
            Close
          </Button>
        </div>

        {!status && <Spinner label="Loading" />}
        {message && (
          <div className="mt-3">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}

        {status && !agent && (
          <div className="mt-3 space-y-5">
            <p className="text-muted">
              Install the printing app on the computer that is connected to your printers. After
              that, you only press <strong>Print</strong> on an order and it comes out of the right
              printer with the right settings.
            </p>
            <ol className="space-y-4">
              <li>
                <p className="font-semibold">1. Install the app on the shop computer</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {STORE_URL && (
                    <a
                      href={STORE_URL}
                      className="inline-flex min-h-11 items-center rounded-xl bg-ink px-4 text-sm font-semibold text-white"
                    >
                      Get it from the Microsoft Store
                    </a>
                  )}
                  {DOWNLOAD_URL && (
                    <a
                      href={DOWNLOAD_URL}
                      className="inline-flex min-h-11 items-center rounded-xl border border-line px-4 text-sm font-semibold"
                    >
                      Download the installer
                    </a>
                  )}
                  {!STORE_URL && !DOWNLOAD_URL && (
                    <p className="text-sm text-muted">
                      We will install it for you during setup. Ask us for the installer.
                    </p>
                  )}
                </div>
              </li>
              <li>
                <p className="font-semibold">2. Get a code</p>
                {code ? (
                  <div className="mt-2 rounded-xl border border-line bg-card p-4 text-center">
                    <p
                      className="font-mono text-4xl font-semibold tracking-[0.3em]"
                      aria-label={`Code ${code.code.split('').join(' ')}`}
                    >
                      {code.code}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      <Countdown until={code.expiresAt} />
                    </p>
                  </div>
                ) : (
                  <Button
                    className="mt-2"
                    variant="secondary"
                    disabled={busy || !canEdit}
                    onClick={() => void getCode()}
                  >
                    Show a code
                  </Button>
                )}
                {!canEdit && (
                  <p className="mt-2 text-sm text-muted">Only the shop owner can set this up.</p>
                )}
              </li>
              <li>
                <p className="font-semibold">3. Type the code into the app</p>
                <p className="mt-1 text-sm text-muted">
                  This page notices by itself when the app is linked.
                </p>
              </li>
            </ol>
          </div>
        )}

        {status && agent && (
          <div className="mt-3 space-y-5">
            <div
              className={`flex items-center gap-3 rounded-xl px-4 py-3 ${
                agent.connected ? 'bg-ok-wash text-ok' : 'bg-magenta-wash text-magenta'
              }`}
              role="status"
            >
              <span
                className={`inline-block size-3 rounded-full ${agent.connected ? 'bg-ok' : 'bg-magenta pulse-dot'}`}
                aria-hidden
              />
              <div>
                <p className="font-semibold">
                  {agent.connected && status.ready
                    ? 'Printing connected ✓'
                    : agent.connected
                      ? 'App connected. Choose your printers below.'
                      : 'The printing app is offline'}
                </p>
                <p className="text-sm">
                  {agent.name}
                  {agent.version ? ` · version ${agent.version}` : ''}
                  {!agent.connected && agent.lastSeenAt
                    ? ` · last seen ${timeAgo(agent.lastSeenAt)}`
                    : ''}
                </p>
              </div>
            </div>
            {!agent.connected && (
              <p className="text-sm text-muted">
                Check that the shop computer is on and the app is running (look for it near the
                clock). Orders you print meanwhile wait and print when it is back. You can also
                print by hand from the order.
              </p>
            )}

            <div className="space-y-4">
              {MODES.map(({ key, label }) => {
                const choice = draft?.[key] ?? null;
                const mapped = status.mapping[key];
                return (
                  <div key={key} className="rounded-xl border border-line bg-card p-3">
                    <label className="block text-sm font-semibold">
                      {label}
                      <select
                        className="mt-1.5 min-h-11 w-full rounded-lg border border-line bg-card px-2 font-normal"
                        value={choice?.printerName ?? ''}
                        disabled={!canEdit}
                        onChange={(e) => {
                          touched.current.add(key);
                          const printer = status.printers.find((p) => p.name === e.target.value);
                          setDraft((d) => ({
                            ...(d ?? { black_white: null, color: null }),
                            [key]: printer
                              ? {
                                  printerName: printer.name,
                                  supportsDuplex: printer.supportsDuplex === true,
                                }
                              : null,
                          }));
                        }}
                      >
                        <option value="">Not chosen</option>
                        {status.printers.map((p) => (
                          <option key={p.name} value={p.name}>
                            {describePrinter(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                    {choice && (
                      <label className="mt-2 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-5"
                          checked={choice.supportsDuplex}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...(d ?? { black_white: null, color: null }),
                              [key]: { ...choice, supportsDuplex: e.target.checked },
                            }))
                          }
                        />
                        This printer prints on both sides of the paper
                      </label>
                    )}
                    {mapped?.missing && (
                      <p className="mt-2 text-sm text-magenta">
                        “{mapped.printerName}” is not on the shop computer any more. Choose another.
                      </p>
                    )}
                  </div>
                );
              })}
              {status.printers.length === 0 && (
                <p className="text-sm text-muted">
                  The app has not reported any printers yet. Make sure they are installed in
                  Windows.
                </p>
              )}
            </div>

            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !changed} onClick={() => void save()}>
                  Save printers
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || changed || !agent.connected || !status.ready}
                  onClick={() =>
                    void run(async () => {
                      const r = await ownerApi.sendTestPages(shopId);
                      return r.sent === 1
                        ? 'A test page is on its way to the printer.'
                        : `${r.sent} test pages are on their way, one to each printer.`;
                    })
                  }
                >
                  Send test page
                </Button>
              </div>
            )}
            {changed && canEdit && (
              <p className="text-sm text-muted">Save your changes before sending a test page.</p>
            )}

            {canEdit && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted">Use a different computer</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-muted">
                    Show a new code and type it into the app on the other computer. This one stops
                    printing for the shop.
                  </p>
                  {code ? (
                    <div className="rounded-xl border border-line bg-card p-4 text-center">
                      <p className="font-mono text-3xl font-semibold tracking-[0.3em]">
                        {code.code}
                      </p>
                      <p className="mt-1 text-muted">
                        <Countdown until={code.expiresAt} />
                      </p>
                    </div>
                  ) : (
                    <Button variant="secondary" disabled={busy} onClick={() => void getCode()}>
                      Show a code
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          'Remove this computer? Orders will no longer print automatically.',
                        )
                      ) {
                        void run(async () => {
                          await ownerApi.removePrintingApp(shopId, agent.id);
                          setDraft(null);
                          await load();
                          return 'Removed.';
                        });
                      }
                    }}
                  >
                    Remove this computer
                  </Button>
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
