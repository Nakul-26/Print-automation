import { useEffect, useState } from 'react';
import { MAX_PRICE_PER_SIDE_PAISE, type RateEntry, type RatesBody } from '@print/contracts';
import { ratesApi } from '../../lib/admin-api';
import { ApiError } from '../../lib/api';
import { COLOR_LABEL, PAPER_LABEL, SIDES_LABEL } from '../../lib/format';
import { Button, Notice, Spinner } from '../ui';

const COMBOS: Omit<RateEntry, 'pricePerSidePaise'>[] = (['A4', 'A3'] as const).flatMap(
  (paperSize) =>
    (['black_white', 'color'] as const).flatMap((colorMode) =>
      (['single', 'double'] as const).map((sides) => ({ paperSize, colorMode, sides })),
    ),
);
const keyOf = (c: Omit<RateEntry, 'pricePerSidePaise'>) =>
  `${c.paperSize}/${c.colorMode}/${c.sides}`;
const toRupees = (paise: number) => String(paise / 100);

/** The shop's price list: a price per side for each paper size, colour and sides; blank means "not offered". */
export function RatesPanel({
  shopId,
  canEdit,
  onClose,
}: {
  shopId: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [prices, setPrices] = useState<Record<string, string> | null>(null);
  const [minimum, setMinimum] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ratesApi
      .get(shopId)
      .then((body) => {
        setPrices(
          Object.fromEntries(body.rates.map((r) => [keyOf(r), toRupees(r.pricePerSidePaise)])),
        );
        setMinimum(toRupees(body.minimumChargePaise));
      })
      .catch((err) =>
        setMessage({
          tone: 'error',
          text: err instanceof ApiError ? err.message : 'Could not load.',
        }),
      );
  }, [shopId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (!prices) return;
    const rates: RateEntry[] = [];
    for (const combo of COMBOS) {
      const raw = (prices[keyOf(combo)] ?? '').trim();
      if (raw === '') continue;
      const paise = Math.round(Number(raw) * 100);
      if (!Number.isFinite(paise) || paise < 0 || paise > MAX_PRICE_PER_SIDE_PAISE) {
        setMessage({
          tone: 'error',
          text: `Check the price for ${keyOf(combo)}. Use a number up to ₹1000.`,
        });
        return;
      }
      rates.push({ ...combo, pricePerSidePaise: paise });
    }
    const minimumChargePaise = Math.round(Number(minimum || '0') * 100);
    if (rates.length === 0) {
      setMessage({ tone: 'error', text: 'Set at least one price, or students cannot order.' });
      return;
    }
    if (!Number.isFinite(minimumChargePaise) || minimumChargePaise < 0) {
      setMessage({ tone: 'error', text: 'Check the minimum charge.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const body: RatesBody = { rates, minimumChargePaise };
      await ratesApi.save(shopId, body);
      setMessage({ tone: 'ok', text: 'Saved. Students see the new prices straight away.' });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError ? err.message : 'Could not save.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Prices"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink/60 p-3"
      onClick={onClose}
    >
      <div
        className="my-auto w-full max-w-lg rounded-card bg-paper p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="display text-2xl">Prices</h2>
          <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="mt-2 text-sm text-muted">
          Price per printed side, in rupees. Leave a box empty if you do not offer it.
        </p>
        {!prices && !message && <Spinner label="Loading" />}
        {message && (
          <div className="mt-3">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}
        {prices && (
          <div className="mt-4 space-y-2">
            {COMBOS.map((combo) => (
              <label key={keyOf(combo)} className="flex items-center justify-between gap-3">
                <span className="text-sm">
                  {PAPER_LABEL[combo.paperSize]} · {COLOR_LABEL[combo.colorMode]} ·{' '}
                  {SIDES_LABEL[combo.sides]}
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-muted">₹</span>
                  <input
                    inputMode="decimal"
                    value={prices[keyOf(combo)] ?? ''}
                    onChange={(e) => setPrices((p) => ({ ...p, [keyOf(combo)]: e.target.value }))}
                    disabled={!canEdit}
                    className="min-h-11 w-24 rounded-xl border border-line bg-white px-3 text-right"
                  />
                </span>
              </label>
            ))}
            <label className="flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="text-sm">Minimum charge per order</span>
              <span className="flex items-center gap-1">
                <span className="text-muted">₹</span>
                <input
                  inputMode="decimal"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                  disabled={!canEdit}
                  className="min-h-11 w-24 rounded-xl border border-line bg-white px-3 text-right"
                />
              </span>
            </label>
            {canEdit ? (
              <Button className="mt-3 w-full" onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save prices'}
              </Button>
            ) : (
              <p className="text-sm text-muted">Only the shop owner can change prices.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
