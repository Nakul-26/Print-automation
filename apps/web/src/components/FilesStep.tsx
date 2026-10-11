import { useRef, useState, type DragEvent } from 'react';
import type { PublicShopInfo } from '@print/contracts';
import type { DraftItem } from '../lib/draft';
import { formatBytes } from '../lib/format';
import { Button, Notice } from './ui';

const ACCEPT =
  '.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';

export function FilesStep({
  shop,
  items,
  onAdd,
  onRemove,
}: {
  shop: PublicShopInfo;
  items: DraftItem[];
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const maxMb = Math.floor(shop.limits.maxUploadBytes / (1024 * 1024));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onAdd(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`rounded-card border-2 border-dashed p-6 text-center transition-colors ${
          over ? 'border-cyan bg-cyan-wash' : 'border-line bg-card'
        }`}
      >
        <p className="display text-xl">Add your files</p>
        <p className="mx-auto mt-2 max-w-xs text-sm text-muted">
          PDF, Word, PowerPoint, Excel or a photo. Up to {maxMb} MB each.
        </p>
        <Button className="mt-4 w-full sm:w-auto" onClick={() => input.current?.click()}>
          Choose files
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose files to print"
          onChange={(e) => {
            onAdd(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        <p className="mt-3 text-xs text-muted">
          Your files are deleted from our server {shop.limits.retentionHours} hours after you place
          the order.
        </p>
      </div>

      {items.length > 0 && (
        <ul className="space-y-2" aria-label="Your files">
          {items.map((item) => (
            <li key={item.key} className="rounded-card border border-line bg-card p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{item.name}</p>
                  <p className="font-mono text-xs text-muted">
                    {formatBytes(item.size)}
                    {item.upload?.pageCount
                      ? ` · ${item.upload.pageCount} ${item.upload.pageCount === 1 ? 'page' : 'pages'}`
                      : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(item.key)}
                  className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-magenta hover:bg-magenta-wash"
                  aria-label={`Remove ${item.name}`}
                >
                  Remove
                </button>
              </div>

              {item.phase === 'uploading' && (
                <div className="mt-2.5" aria-live="polite">
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full bg-cyan transition-[width]"
                      style={{ width: `${Math.round(item.progress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    Uploading {Math.round(item.progress * 100)}%
                  </p>
                </div>
              )}
              {item.phase === 'processing' && (
                <p className="mt-2 flex items-center gap-2 text-sm text-muted" aria-live="polite">
                  <span
                    className="pulse-dot inline-block size-2 rounded-full bg-cyan"
                    aria-hidden
                  />
                  {item.upload?.documentKind === 'office'
                    ? 'Converting to PDF…'
                    : 'Getting your file ready…'}
                </p>
              )}
              {item.phase === 'ready' && <p className="mt-2 text-sm font-medium text-ok">Ready</p>}
              {item.phase === 'failed' && (
                <div className="mt-2">
                  <Notice tone="error">{item.error ?? 'This file could not be used.'}</Notice>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
