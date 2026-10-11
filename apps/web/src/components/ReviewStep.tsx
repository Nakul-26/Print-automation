import type { EstimateResponse, PublicShopInfo } from '@print/contracts';
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
}) {
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
        <p className="mt-2 text-xs text-muted">
          You pay at the counter. The shop confirms the final amount when you collect your prints.
        </p>
      </Card>

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
