import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  REALTIME,
  type OrderActionBody,
  type OwnerOrder,
  type PrintingStatus,
  type ShopDetail,
} from '@print/contracts';
import { FileDialog } from '../../components/owner/FileDialog';
import { OrderCard } from '../../components/owner/OrderCard';
import { PrintingPanel } from '../../components/owner/PrintingPanel';
import { RatesPanel } from '../../components/owner/RatesPanel';
import { QrPanel } from '../../components/owner/QrPanel';
import { Button, Notice, Spinner } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { isUnauthenticated, ownerApi } from '../../lib/owner-api';
import { useRealtime } from '../../lib/realtime';
import { playNewOrderChime, setSoundEnabled, soundEnabled, unlockSound } from '../../lib/sound';

// Live events do the real work; this poll only covers a blocked socket and keeps "5 min ago" fresh.
const FALLBACK_POLL_MS = 30_000;

const WAITING = ['pending'];
const IN_PROGRESS = ['accepted', 'printing'];

export function QueuePage() {
  const { shopId = '' } = useParams();
  const navigate = useNavigate();

  const [shop, setShop] = useState<ShopDetail | null>(null);
  const [orders, setOrders] = useState<OwnerOrder[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showPrinting, setShowPrinting] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [printing, setPrinting] = useState<PrintingStatus | null>(null);
  const [sound, setSound] = useState(soundEnabled);
  const [, setTick] = useState(0);
  const seen = useRef<Set<string> | null>(null);

  const leave = useCallback(
    (err: unknown) => {
      if (isUnauthenticated(err)) navigate('/owner', { replace: true });
    },
    [navigate],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await ownerApi.queue(shopId);
      // Chime for orders that were not here before, but not for the first load of the page.
      const waiting = new Set(next.filter((o) => o.status === 'pending').map((o) => o.id));
      if (seen.current && [...waiting].some((id) => !seen.current!.has(id))) playNewOrderChime();
      seen.current = waiting;
      setOrders(next);
      setLoadError(null);
    } catch (err) {
      leave(err);
      if (err instanceof ApiError && err.status === 404) {
        setLoadError('You do not have access to this shop.');
      } else if (err instanceof ApiError && err.status !== 401) {
        setLoadError(err.status === 0 ? 'No connection. Retrying…' : err.message);
      }
    }
  }, [shopId, leave]);

  const connected = useRealtime({
    watch: { event: REALTIME.watchShop, payload: { shopId } },
    changeEvents: [REALTIME.queueChanged],
    onChange: () => void refresh(),
  });

  useEffect(() => {
    ownerApi.shop(shopId).then(setShop).catch(leave);
  }, [shopId, leave]);

  // The header shows at a glance whether the printing app is connected.
  useEffect(() => {
    const check = () =>
      ownerApi
        .printing(shopId)
        .then(setPrinting)
        .catch(() => undefined);
    void check();
    const timer = setInterval(check, 20_000);
    return () => clearInterval(timer);
  }, [shopId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      setTick((t) => t + 1);
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (shop) document.title = `Queue · ${shop.name}`;
  }, [shop]);

  const act = async (order: OwnerOrder, body: OrderActionBody) => {
    unlockSound();
    setBusyId(order.id);
    setCardErrors(({ [order.id]: _gone, ...rest }) => rest);
    try {
      const updated = await ownerApi.act(shopId, order.id, body);
      setOrders((list) => list?.map((o) => (o.id === updated.id ? updated : o)) ?? list);
    } catch (err) {
      leave(err);
      setCardErrors((e) => ({
        ...e,
        [order.id]: err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
      }));
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
    if (next) {
      unlockSound();
      playNewOrderChime();
    }
  };

  const signOut = async () => {
    await ownerApi.logout();
    navigate('/owner', { replace: true });
  };

  const byNumber = (a: OwnerOrder, b: OwnerOrder) => a.createdAt.localeCompare(b.createdAt);
  const waiting = orders?.filter((o) => WAITING.includes(o.status)).sort(byNumber) ?? [];
  const inProgress = orders?.filter((o) => IN_PROGRESS.includes(o.status)).sort(byNumber) ?? [];
  const preparing = orders?.filter((o) => o.status === 'processing') ?? [];
  const finished =
    orders
      ?.filter((o) => ['completed', 'rejected', 'failed', 'expired'].includes(o.status))
      .reverse() ?? [];

  const card = (order: OwnerOrder) => (
    <OrderCard
      key={order.id}
      order={order}
      shopId={shopId}
      busy={busyId === order.id}
      error={cardErrors[order.id] ?? null}
      onAct={(body) => void act(order, body)}
      onPreview={(url, title) => setPreview({ url, title })}
    />
  );

  return (
    <>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-5 print:hidden" onClick={unlockSound}>
        <header className="mb-5">
          <div className="flex items-center justify-between gap-3">
            <Link to="/owner" className="font-mono text-xs uppercase tracking-wide text-muted">
              Your shops
            </Link>
            <p
              className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide"
              role="status"
            >
              <span
                className={`inline-block size-2.5 rounded-full ${connected ? 'bg-ok' : 'bg-magenta pulse-dot'}`}
                aria-hidden
              />
              {connected ? 'Live' : 'Reconnecting'}
            </p>
          </div>
          <h1 className="display mt-1 text-3xl sm:text-4xl">{shop?.name ?? 'Queue'}</h1>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="min-h-10 px-4 text-sm"
              onClick={() => setShowQr(true)}
              disabled={!shop}
            >
              QR code
            </Button>
            <Button
              variant="secondary"
              className="min-h-10 gap-2 px-4 text-sm"
              onClick={() => setShowPrinting(true)}
            >
              <span
                className={`inline-block size-2.5 rounded-full ${
                  printing?.agent?.connected && printing.ready
                    ? 'bg-ok'
                    : printing?.agent
                      ? 'bg-magenta'
                      : 'bg-line'
                }`}
                aria-hidden
              />
              {printing?.agent
                ? printing.agent.connected && printing.ready
                  ? 'Printing connected'
                  : 'Printing needs attention'
                : 'Set up printing'}
            </Button>
            <Button
              variant="secondary"
              className="min-h-10 px-4 text-sm"
              onClick={() => setShowRates(true)}
            >
              Prices
            </Button>
            <Button
              variant="secondary"
              className="min-h-10 px-4 text-sm"
              onClick={toggleSound}
              aria-pressed={sound}
            >
              {sound ? 'Sound on' : 'Sound off'}
            </Button>
            <Button
              variant="ghost"
              className="min-h-10 px-4 text-sm"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </header>

        {shop?.status === 'pending_approval' && (
          <div className="mb-4">
            <Notice>
              Your shop is waiting for approval. You can already set your prices and connect your
              printers. Students can use your QR code once it is approved.
            </Notice>
          </div>
        )}
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {!orders && !loadError && <Spinner label="Loading the queue" />}

        {orders && (
          <div className="space-y-8">
            <section aria-labelledby="waiting-h">
              <h2
                id="waiting-h"
                className="mb-3 font-mono text-xs uppercase tracking-wide text-muted"
              >
                Waiting · {waiting.length}
              </h2>
              {waiting.length === 0 ? (
                <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-muted">
                  No orders waiting. New ones appear here by themselves.
                </p>
              ) : (
                <div className="space-y-4">{waiting.map(card)}</div>
              )}
            </section>

            {inProgress.length > 0 && (
              <section aria-labelledby="progress-h">
                <h2
                  id="progress-h"
                  className="mb-3 font-mono text-xs uppercase tracking-wide text-muted"
                >
                  Printing · {inProgress.length}
                </h2>
                <div className="space-y-4">{inProgress.map(card)}</div>
              </section>
            )}

            {preparing.length > 0 && (
              <p className="text-sm text-muted">
                {preparing.length} {preparing.length === 1 ? 'order is' : 'orders are'} being
                prepared and will appear above in a moment.
              </p>
            )}

            {finished.length > 0 && (
              <details>
                <summary className="cursor-pointer font-mono text-xs uppercase tracking-wide text-muted">
                  Finished in the last day · {finished.length}
                </summary>
                <div className="mt-3 space-y-4">{finished.map(card)}</div>
              </details>
            )}
          </div>
        )}
      </main>

      {preview && (
        <FileDialog url={preview.url} title={preview.title} onClose={() => setPreview(null)} />
      )}
      {showRates && shop && (
        <RatesPanel
          shopId={shopId}
          canEdit={shop.role === 'owner'}
          onClose={() => setShowRates(false)}
        />
      )}
      {showPrinting && shop && (
        <PrintingPanel
          shopId={shopId}
          canEdit={shop.role === 'owner'}
          onClose={() => setShowPrinting(false)}
          onStatus={setPrinting}
        />
      )}
      {showQr && shop && (
        <QrPanel slug={shop.slug} name={shop.name} onClose={() => setShowQr(false)} />
      )}
    </>
  );
}
