import type { ColorMode, PaperSize } from '@print/contracts';
import { ProcessingError } from './errors.js';
import { GRAYSCALE_ARGS, runGhostscript, type GhostscriptOptions } from './ghostscript.js';
import { inspectPdf, selectPages } from './pdf.js';

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
  grid: string; // "columns x rows"
}

/**
 * Chooses the sheet orientation and grid so each cell has the same orientation as the pages:
 * portrait pages go 2-up on a landscape sheet and 4-up on a portrait sheet, and landscape
 * pages the other way round.
 */
function nupLayout(paper: PaperSize, perSheet: 2 | 4, landscapePages: boolean): Layout {
  const { w, h } = PAPER_POINTS[paper];
  const landscapeSheet = perSheet === 2 ? !landscapePages : landscapePages;
  const grid = perSheet === 4 ? '2x2' : landscapePages ? '1x2' : '2x1';
  return landscapeSheet ? { sheetW: h, sheetH: w, grid } : { sheetW: w, sheetH: h, grid };
}

/**
 * Produces the exact PDF that gets printed: selected pages only, laid out N-up, and truly
 * grayscale for black-and-white jobs. Copies and duplex are left to the printer/agent.
 */
export async function buildPrintPdf(
  gs: GhostscriptOptions,
  maxPages: number,
  request: PrintPdfRequest,
): Promise<Buffer> {
  let bytes = request.source;
  if (request.pages) bytes = await selectPages(bytes, request.pages);

  const needsGhostscript = request.colorMode === 'black_white' || request.pagesPerSheet > 1;
  if (!needsGhostscript) return bytes;

  const args: string[] = [];
  if (request.colorMode === 'black_white') args.push(...GRAYSCALE_ARGS);
  if (request.pagesPerSheet !== 1) {
    const info = await inspectPdf(bytes, maxPages);
    const layout = nupLayout(request.paperSize, request.pagesPerSheet, info.mostlyLandscape);
    args.push(
      `-sNupControl=${layout.grid}`,
      '-dFIXEDMEDIA',
      `-dDEVICEWIDTHPOINTS=${layout.sheetW}`,
      `-dDEVICEHEIGHTPOINTS=${layout.sheetH}`,
    );
  }

  const { output } = await runGhostscript(gs, args, bytes);
  if (!output.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new ProcessingError('processing_failed', 'Could not prepare this document for printing');
  }
  return output;
}
