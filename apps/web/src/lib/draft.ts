import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrintSettingsInput, PublicShopInfo, UploadView } from '@print/contracts';
import { api, ApiError, uploadFile } from './api';
import { firstAvailable } from './format';

export interface DraftItem {
  /** Local id, stable across the item's life. */
  key: string;
  /** Secret handle from the server once the upload has been accepted. */
  token: string | null;
  name: string;
  size: number;
  phase: 'uploading' | 'processing' | 'ready' | 'failed';
  progress: number;
  upload: UploadView | null;
  error: string | null;
  settings: PrintSettingsInput;
}

interface StoredItem {
  token: string;
  name: string;
  size: number;
  settings: PrintSettingsInput;
}

const POLL_MS = 1200;

function storageKey(slug: string): string {
  return `print-draft:${slug}`;
}

function readStored(slug: string): StoredItem[] {
  try {
    const raw = sessionStorage.getItem(storageKey(slug));
    return raw ? (JSON.parse(raw) as StoredItem[]) : [];
  } catch {
    return [];
  }
}

function newKey(): string {
  return crypto.randomUUID();
}

export function defaultSettings(shop: PublicShopInfo): PrintSettingsInput {
  return {
    pageSelection: 'all',
    copies: 1,
    pagesPerSheet: 1,
    ...firstAvailable(shop.rates),
  };
}

function phaseOf(upload: UploadView): DraftItem['phase'] {
  return upload.status === 'ready' ? 'ready' : upload.status === 'failed' ? 'failed' : 'processing';
}

/**
 * The student's in-progress order: uploads, their conversion state, and print settings.
 * Uploads are remembered for the browser tab, so a refresh does not lose them.
 */
export function useOrderDraft(slug: string, shop: PublicShopInfo | null) {
  const [items, setItems] = useState<DraftItem[]>([]);
  const cancels = useRef(new Map<string, () => void>());
  const restored = useRef(false);

  const patch = useCallback((key: string, change: Partial<DraftItem>) => {
    setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  // Bring back uploads from earlier in this tab.
  useEffect(() => {
    if (!shop || restored.current) return;
    restored.current = true;
    const stored = readStored(slug);
    if (stored.length === 0) return;
    void Promise.all(
      stored.map(async (s): Promise<DraftItem | null> => {
        try {
          const upload = await api.getUpload(s.token);
          return {
            key: newKey(),
            token: s.token,
            name: s.name,
            size: s.size,
            phase: phaseOf(upload),
            progress: 1,
            upload,
            error: upload.status === 'failed' ? upload.errorMessage : null,
            settings: s.settings,
          };
        } catch {
          return null; // expired or discarded
        }
      }),
    ).then((restoredItems) =>
      setItems((current) => [
        ...restoredItems.filter((i): i is DraftItem => i !== null),
        ...current,
      ]),
    );
  }, [slug, shop]);

  // Remember uploads that the server accepted.
  useEffect(() => {
    if (!restored.current) return;
    const stored: StoredItem[] = items
      .filter((i) => i.token && i.phase !== 'failed')
      .map((i) => ({ token: i.token!, name: i.name, size: i.size, settings: i.settings }));
    try {
      sessionStorage.setItem(storageKey(slug), JSON.stringify(stored));
    } catch {
      /* private mode: the draft simply is not remembered */
    }
  }, [items, slug]);

  // Follow files that are still being prepared.
  useEffect(() => {
    const busy = items.filter((i) => i.token && i.phase === 'processing');
    if (busy.length === 0) return;
    const timer = setInterval(() => {
      for (const item of busy) {
        api
          .getUpload(item.token!)
          .then((upload) =>
            patch(item.key, {
              upload,
              phase: phaseOf(upload),
              error: upload.status === 'failed' ? upload.errorMessage : null,
            }),
          )
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [items, patch]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!shop) return;
      for (const file of files) {
        const key = newKey();
        const base: DraftItem = {
          key,
          token: null,
          name: file.name,
          size: file.size,
          phase: 'uploading',
          progress: 0,
          upload: null,
          error: null,
          settings: defaultSettings(shop),
        };
        if (file.size > shop.limits.maxUploadBytes) {
          const mb = Math.floor(shop.limits.maxUploadBytes / (1024 * 1024));
          setItems((all) => [
            ...all,
            { ...base, phase: 'failed', error: `This file is larger than ${mb} MB.` },
          ]);
          continue;
        }
        setItems((all) => [...all, base]);
        const { promise, cancel } = uploadFile(slug, file, (progress) => patch(key, { progress }));
        cancels.current.set(key, cancel);
        promise
          .then(({ token, upload }) =>
            patch(key, { token, upload, phase: phaseOf(upload), progress: 1, error: null }),
          )
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === 'aborted') return;
            patch(key, {
              phase: 'failed',
              error: err instanceof ApiError ? err.message : 'The upload failed. Please try again.',
            });
          })
          .finally(() => cancels.current.delete(key));
      }
    },
    [shop, slug, patch],
  );

  const remove = useCallback(
    (key: string) => {
      cancels.current.get(key)?.();
      const item = items.find((i) => i.key === key);
      if (item?.token) void api.discardUpload(item.token);
      setItems((all) => all.filter((i) => i.key !== key));
    },
    [items],
  );

  const updateSettings = useCallback((key: string, change: Partial<PrintSettingsInput>) => {
    setItems((all) =>
      all.map((i) => (i.key === key ? { ...i, settings: { ...i.settings, ...change } } : i)),
    );
  }, []);

  const changeConversion = useCallback(
    async (key: string, settings: Record<string, unknown>) => {
      const item = items.find((i) => i.key === key);
      if (!item?.token) return;
      try {
        const upload = await api.changeConversion(item.token, settings);
        patch(key, { upload, phase: phaseOf(upload), error: null });
      } catch (err) {
        patch(key, {
          error: err instanceof ApiError ? err.message : 'Could not change that setting.',
        });
      }
    },
    [items, patch],
  );

  const clear = useCallback(() => {
    try {
      sessionStorage.removeItem(storageKey(slug));
    } catch {
      /* ignore */
    }
    setItems([]);
  }, [slug]);

  const ready = items.filter((i) => i.phase === 'ready');
  return {
    items,
    ready,
    busy: items.some((i) => i.phase === 'uploading' || i.phase === 'processing'),
    addFiles,
    remove,
    updateSettings,
    changeConversion,
    clear,
  };
}
