import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { Spinner } from './ui';

type PdfDocument = PDFDocumentProxy;

/**
 * Renders a PDF page by page onto a canvas. Phones cannot show PDFs inline (Android Chrome
 * and iOS Safari only show the first page, or offer a download), so the app draws them itself.
 */
export function PdfPreview({ url, revision }: { url: string; revision: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Load the document (and the PDF library, only when a preview is opened).
  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    setState('loading');
    setDoc(null);
    setPage(1);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const loading = pdfjs.getDocument({ url, withCredentials: false });
        task = loading;
        const loaded = await loading.promise;
        if (cancelled) return;
        setDoc(loaded);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url, revision]);

  // Draw the current page, sharp on high-density screens.
  useEffect(() => {
    if (!doc || !canvasRef.current || !wrapRef.current) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const pdfPage = await doc.getPage(page);
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const width = wrapRef.current?.clientWidth ?? 320;
      const scale = width / natural.width;
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: scale * ratio });
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
      const render = pdfPage.render({ canvas, viewport });
      task = render;
      await render.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page]);

  if (state === 'error') {
    return <p className="p-4 text-sm text-magenta">The preview could not be loaded.</p>;
  }

  const pages = doc?.numPages ?? 0;
  return (
    <div>
      <div ref={wrapRef} className="overflow-hidden rounded-lg border border-line bg-white">
        {state === 'loading' ? (
          <div className="grid h-64 place-items-center">
            <Spinner label="Loading preview" />
          </div>
        ) : (
          <canvas ref={canvasRef} aria-label={`Page ${page} of ${pages}`} className="block" />
        )}
      </div>
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            className="min-h-11 rounded-lg border border-line px-4 text-sm font-medium disabled:opacity-40"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span className="font-mono text-sm text-muted">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-line px-4 text-sm font-medium disabled:opacity-40"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page >= pages}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
