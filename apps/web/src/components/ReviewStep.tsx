import {
  MIN_ONLINE_PAYMENT_PAISE,
  type EstimateResponse,
  type PublicShopInfo,
} from '@print/contracts';
import type { DraftItem } from '../lib/draft';
import { describeSettings, formatRupees } from '../lib/format';
import { Turnstile } from './Turnstile';
import { Card, Notice } from './ui';

export function ReviewStep({
  shop,
  items,
  estimate,
  name,
  onName,
  onToken,
  nonce,
  error,
  payment,
  onPayment,
}: {
  shop: PublicShopInfo;
  items: DraftItem[];
  estimate: EstimateResponse | null;
  name: string;
  onName: (value: string) => void;
  onToken: (token: string | null) => void;
  /** Changes after a failed bot check so the widget is drawn again. */
  nonce: number;
  error: string | null;
  /** How the student wants to pay; online is only offered when the shop has it switched on. */
  payment: 'online' | 'counter';
  onPayment: (value: 'online' | 'counter') => void;
}) {
  const canPayOnline =
    shop.onlinePayments && estimate !== null && estimate.totalPaise >= MIN_ONLINE_PAYMENT_PAISE;
  const amountFor = (token: string | null) =>
    estimate?.items.find((i) => i.uploadToken === token)?.amountPaise ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="display text-xl">Your order</h2>
        <ul className="mt-3 divide-y divide-line">
          {items.map((item) => {
            const amount = amountFor(item.token);
            return (
              <li key={item.key} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="text-sm text-muted">{describeSettings(item.settings)}</p>
                </div>
                <p className="shrink-0 font-mono">{amount === null ? '—' : formatRupees(amount)}</p>
              </li>
            );
          })}
        </ul>

        {estimate?.minimumApplied && (
          <p className="mt-2 text-sm text-muted">
            This shop’s minimum charge is {formatRupees(estimate.minimumChargePaise)}.
          </p>
        )}
        <div className="mt-3 flex items-baseline justify-between border-t border-ink pt-3">
          <span className="font-medium">Estimated total</span>
          <span className="display text-3xl">
            {estimate ? formatRupees(estimate.totalPaise) : '—'}
          </span>
        </div>
        {!canPayOnline && (
          <p className="mt-2 text-xs text-muted">
            You pay at the counter. The shop confirms the final amount when you collect your prints.
          </p>
        )}
      </Card>

      {canPayOnline && (
        <Card>
          <h2 className="display text-xl">How do you want to pay?</h2>
          <div role="radiogroup" aria-label="Payment" className="mt-3 grid gap-3">
            <PayChoice
              selected={payment === 'online'}
              onSelect={() => onPayment('online')}
              title="Pay online now"
              detail="UPI, cards or net banking, right here. Your order goes to the shop once the payment is done."
            />
            <PayChoice
              selected={payment === 'counter'}
              onSelect={() => onPayment('counter')}
              title="Pay at the counter"
              detail="The shop confirms the final amount when you collect your prints."
            />
          </div>
          {payment === 'online' && (
            <p className="mt-3 text-xs text-muted">
              If the shop cannot print your order, your payment is refunded automatically.
            </p>
          )}
        </Card>
      )}

      <Card>
        <label className="block">
          <span className="text-sm font-medium">Your name (optional)</span>
          <span className="mb-2 block text-xs text-muted">
            So the shop can call you by name as well as by number.
          </span>
          <input
            type="text"
            value={name}
            maxLength={60}
            autoComplete="given-name"
            onChange={(e) => onName(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-line bg-white px-4 text-base"
          />
        </label>
      </Card>

      <Turnstile key={nonce} siteKey={shop.turnstileSiteKey} onToken={onToken} />
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

function PayChoice({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-h-16 items-start gap-3 rounded-xl border p-4 text-left ${
        selected ? 'border-cyan bg-cyan-wash' : 'border-line bg-white hover:border-ink/40'
      }`}
    >
      <span
        aria-hidden
        className={`mt-1 grid size-5 shrink-0 place-items-center rounded-full border-2 ${
          selected ? 'border-cyan' : 'border-line'
        }`}
      >
        {selected && <span className="size-2.5 rounded-full bg-cyan" />}
      </span>
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="block text-sm text-muted">{detail}</span>
      </span>
    </button>
  );
}
