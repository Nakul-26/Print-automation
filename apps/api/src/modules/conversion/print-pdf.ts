import type { ColorMode, PaperSize } from '@print/contracts';
import { ProcessingError } from './errors.js';
import { GRAYSCALE_ARGS, runGhostscript, type GhostscriptOptions } from './ghostscript.js';
import { inspectPdf, layoutNup, selectPages } from './pdf.js';

export interface PrintPdfRequest {
  /** The normalised PDF produced when the document was uploaded. */
  source: Buffer;
  /** 1-based pages to include, in order. Omit for the whole document. */
  pages?: number[];
  colorMode: ColorMode;
  pagesPerSheet: 1 | 2 | 4;
  paperSize: PaperSize;
}

const PAPER_POINTS: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 595, h: 842 },
  A3: { w: 842, h: 1191 },
};

interface Layout {
  sheetW: number;
  sheetH: number;
  cols: number;
  rows: number;
}

/**
 * Chooses the sheet orientation and grid so each cell has the same orientation as the pages:
 * portrait pages go 2-up on a landscape sheet and 4-up on a portrait sheet, and landscape
 * pages the other way round.
 */
function nupLayout(paper: PaperSize, perSheet: 2 | 4, landscapePages: boolean): Layout {
  const { w, h } = PAPER_POINTS[paper];
  const landscapeSheet = perSheet === 2 ? !landscapePages : landscapePages;
  const [cols, rows] = perSheet === 4 ? [2, 2] : landscapePages ? [1, 2] : [2, 1];
  return landscapeSheet
    ? { sheetW: h, sheetH: w, cols, rows }
    : { sheetW: w, sheetH: h, cols, rows };
}

/**
 * Produces the exact PDF that gets printed: selected pages only, laid out N-up (by us, so layout is predictable), and truly
 * grayscale for black-and-white jobs. Copies and duplex are left to the printer/agent.
 */
export async function buildPrintPdf(
  gs: GhostscriptOptions,
  maxPages: number,
  request: PrintPdfRequest,
): Promise<Buffer> {
  let bytes = request.source;
  if (request.pages) bytes = await selectPages(bytes, request.pages);

  if (request.pagesPerSheet !== 1) {
    const info = await inspectPdf(bytes, maxPages);
    bytes = await layoutNup(
      bytes,
      nupLayout(request.paperSize, request.pagesPerSheet, info.mostlyLandscape),
    );
  }
  if (request.colorMode !== 'black_white') return bytes;

  const { output } = await runGhostscript(gs, [...GRAYSCALE_ARGS], bytes);
  if (!output.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new ProcessingError('processing_failed', 'Could not prepare this document for printing');
  }
  return output;
}
