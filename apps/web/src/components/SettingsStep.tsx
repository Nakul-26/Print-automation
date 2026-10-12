import { useState } from 'react';
import type { EstimateItem, PrintSettingsInput, PublicShopInfo } from '@print/contracts';
import type { DraftItem } from '../lib/draft';
import { COLOR_LABEL, formatRupees, offered, SIDES_LABEL } from '../lib/format';
import { ConversionSettings } from './ConversionSettings';
import { PrintPreview } from './PrintPreview';
import { Button, Card, Notice, Segmented, Spinner } from './ui';

type Settings = PrintSettingsInput;

/** Keeps colour/sides valid for the chosen paper after any change. */
function normalise(shop: PublicShopInfo, next: Settings): Settings {
  const o = offered(shop.rates);
  const colors = o.color(next.paperSize);
  const colorMode = colors.includes(next.colorMode)
    ? next.colorMode
    : (colors[0] ?? next.colorMode);
  const sidesList = o.sides(next.paperSize, colorMode);
  const sides = sidesList.includes(next.sides) ? next.sides : (sidesList[0] ?? next.sides);
  return { ...next, colorMode, sides };
}

function ItemCard({
  shop,
  item,
  estimate,
  onSettings,
  onConversion,
}: {
  shop: PublicShopInfo;
  item: DraftItem;
  estimate: EstimateItem | undefined;
  onSettings: (change: Partial<Settings>) => void;
  onConversion: (settings: Record<string, unknown>) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const upload = item.upload;
  const s = item.settings;
  const o = offered(shop.rates);
  const converting = item.phase === 'processing';
  const pageCount = upload?.pageCount ?? 0;

  const change = (c: Partial<Settings>) => onSettings(normalise(shop, { ...s, ...c }));

  return (
    <Card className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold">{item.name}</h3>
          <p className="font-mono text-xs text-muted">
            {converting ? 'Converting…' : `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`}
          </p>
        </div>
        {estimate && !converting && (
          <p
            className="display shrink-0 text-xl"
            aria-label={`Price ${formatRupees(estimate.amountPaise)}`}
          >
            {formatRupees(estimate.amountPaise)}
          </p>
        )}
      </header>

      <div>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => setShowPreview((v) => !v)}
          aria-expanded={showPreview}
        >
          {showPreview ? 'Hide preview' : 'See what will print'}
        </Button>
        {showPreview && item.token && (
          <div className="mt-3">
            {converting ? (
              <div className="grid h-40 place-items-center">
                <Spinner label="Updating preview" />
              </div>
            ) : (
              <PrintPreview
                slug={shop.slug}
                token={item.token}
                settings={s}
                revision={upload?.revision ?? 0}
                sheets={estimate?.sheets}
              />
            )}
          </div>
        )}
      </div>

      {item.error && item.phase !== 'failed' && <Notice tone="error">{item.error}</Notice>}
      {upload?.errorMessage && upload.status === 'ready' && (
        <Notice tone="error">{upload.errorMessage}</Notice>
      )}

      {upload?.officeFamily && upload.conversionSettings && (
        <details className="rounded-xl border border-line p-3.5" open={false}>
          <summary className="min-h-11 cursor-pointer text-sm font-semibold leading-[2.75rem]">
            How should this convert to PDF?
          </summary>
          <p className="mb-3 text-xs text-muted">
            Word and PowerPoint files can look different once converted. Change these until the
            preview looks right. For an exact match, upload a PDF instead.
          </p>
          <ConversionSettings
            family={upload.officeFamily}
            settings={upload.conversionSettings}
            busy={converting}
            onChange={onConversion}
          />
        </details>
      )}

      <div className="space-y-4">
        <Segmented
          label="Pages"
          value={s.pageSelection}
          options={[
            { value: 'all', label: 'All pages' },
            { value: 'custom', label: 'Choose pages' },
          ]}
          onChange={(v) => change({ pageSelection: v })}
        />
        {s.pageSelection === 'custom' && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Pages to print</span>
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              placeholder="1-3, 5, 8-10"
              value={s.pages ?? ''}
              onChange={(e) => change({ pages: e.target.value })}
              className="min-h-12 w-full rounded-xl border border-line bg-white px-4 font-mono text-base"
            />
            <span className="mt-1 block text-xs text-muted">
              Out of {pageCount} {pageCount === 1 ? 'page' : 'pages'}. Use commas and dashes.
            </span>
          </label>
        )}

        <div>
          <span className="mb-1.5 block text-sm font-medium text-muted">Copies</span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="size-12 !px-0 text-xl"
              aria-label="Fewer copies"
              disabled={s.copies <= 1}
              onClick={() => change({ copies: Math.max(1, s.copies - 1) })}
            >
              −
            </Button>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={shop.limits.maxCopies}
              aria-label="Number of copies"
              value={s.copies}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n))
                  change({ copies: Math.min(shop.limits.maxCopies, Math.max(1, n)) });
              }}
              className="min-h-12 w-20 rounded-xl border border-line bg-white text-center font-mono text-lg"
            />
            <Button
              variant="secondary"
              className="size-12 !px-0 text-xl"
              aria-label="More copies"
              disabled={s.copies >= shop.limits.maxCopies}
              onClick={() => change({ copies: Math.min(shop.limits.maxCopies, s.copies + 1) })}
            >
              +
            </Button>
          </div>
        </div>

        <Segmented
          label="Colour"
          value={s.colorMode}
          options={(['black_white', 'color'] as const).map((c) => ({
            value: c,
            label: COLOR_LABEL[c],
            disabled: !o.color(s.paperSize).includes(c),
          }))}
          onChange={(v) => change({ colorMode: v })}
        />
        <Segmented
          label="Sides"
          value={s.sides}
          options={(['single', 'double'] as const).map((v) => ({
            value: v,
            label: SIDES_LABEL[v],
            disabled: !o.sides(s.paperSize, s.colorMode).includes(v),
          }))}
          onChange={(v) => change({ sides: v })}
        />
        {o.paper.length > 1 && (
          <Segmented
            label="Paper size"
            value={s.paperSize}
            options={o.paper.map((p) => ({ value: p, label: p }))}
            onChange={(v) => change({ paperSize: v })}
          />
        )}
        <Segmented
          label="Pages per sheet"
          value={s.pagesPerSheet}
          options={([1, 2, 4] as const).map((n) => ({ value: n, label: String(n) }))}
          onChange={(v) => change({ pagesPerSheet: v })}
        />
      </div>

      {estimate && (
        <p className="font-mono text-xs text-muted">
          {estimate.printedSides} printed {estimate.printedSides === 1 ? 'side' : 'sides'} ×{' '}
          {formatRupees(estimate.pricePerSidePaise)}
        </p>
      )}
    </Card>
  );
}

export function SettingsStep({
  shop,
  items,
  estimates,
  estimateError,
  onSettings,
  onConversion,
}: {
  shop: PublicShopInfo;
  items: DraftItem[];
  estimates: Map<string, EstimateItem>;
  estimateError: string | null;
  onSettings: (key: string, change: Partial<Settings>) => void;
  onConversion: (key: string, settings: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-4">
      {estimateError && <Notice tone="error">{estimateError}</Notice>}
      {items.map((item) => (
        <ItemCard
          key={item.key}
          shop={shop}
          item={item}
          estimate={item.token ? estimates.get(item.token) : undefined}
          onSettings={(c) => onSettings(item.key, c)}
          onConversion={(c) => onConversion(item.key, c)}
        />
      ))}
    </div>
  );
}
