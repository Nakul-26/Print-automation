import { useEffect, useMemo, useRef, useState } from 'react';
import type { PrintSettingsInput } from '@print/contracts';
import { api, ApiError } from '../lib/api';
import { PdfPreview } from './PdfPreview';
import { Spinner } from './ui';

/**
 * Shows the PDF the shop will actually print for the current settings: chosen pages only,
 * pages per sheet applied, black and white rendered in gray. It refreshes shortly after each change.
 */
export function PrintPreview({
  slug,
  token,
  settings,
  revision,
  sheets,
}: {
  slug: string;
  token: string;
  settings: PrintSettingsInput;
  /** Changes when the document itself is converted again. */
  revision: number;
  sheets: number | undefined;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [updating, setUpdating] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const urlRef = useRef<string | null>(null);
  const key = useMemo(() => JSON.stringify(settings), [settings]);

  useEffect(() => {
    const controller = new AbortController();
    setUpdating(true);
    const timer = setTimeout(() => {
      api
        .printPreview(slug, { uploadToken: token, settings: JSON.parse(key) }, controller.signal)
        .then((blob) => {
          const next = URL.createObjectURL(blob);
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = next;
          setUrl(next);
          setVersion((v) => v + 1);
          setError(null);
          setUpdating(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // Keep showing the last good preview; say what to fix.
          setError(err instanceof ApiError ? err.message : 'Could not update the preview.');
          setUpdating(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [slug, token, key, revision]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-sm" aria-live="polite">
        <p className="text-muted">
          {settings.colorMode === 'black_white' ? 'Shown in black and white' : 'Shown in colour'}
          {sheets ? ` · ${sheets} ${sheets === 1 ? 'sheet' : 'sheets'} of paper in total` : ''}
        </p>
        {updating && <Spinner label="Updating" />}
      </div>
      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-magenta-wash px-3 py-2 text-sm text-magenta">
          {error}
        </p>
      )}
      {url ? (
        <PdfPreview url={url} revision={version} />
      ) : (
        !error && (
          <div className="grid h-40 place-items-center">
            <Spinner label="Preparing preview" />
          </div>
        )
      )}
    </div>
  );
}
