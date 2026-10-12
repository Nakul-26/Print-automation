import { PDFDocument, degrees } from 'pdf-lib';
import { ProcessingError } from './errors.js';

export interface PdfInfo {
  pageCount: number;
  /** True when most pages are wider than tall (after applying page rotation). */
  mostlyLandscape: boolean;
}

async function load(bytes: Buffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const encrypted = err instanceof Error && /encrypt/i.test(err.message);
    throw new ProcessingError(
      encrypted ? 'encrypted_pdf' : 'corrupt_file',
      encrypted
        ? 'This PDF is password-protected. Remove the password and upload it again.'
        : 'This file could not be read. It may be damaged; try exporting it again.',
      { cause: err },
    );
  }
}

export async function inspectPdf(bytes: Buffer, maxPages: number): Promise<PdfInfo> {
  const doc = await load(bytes);
  const pages = doc.getPages();
  if (pages.length === 0) {
    throw new ProcessingError('empty_document', 'This document has no pages');
  }
  if (pages.length > maxPages) {
    throw new ProcessingError(
      'too_many_pages',
      `This document has ${pages.length} pages; the limit is ${maxPages}.`,
    );
  }
  let landscape = 0;
  for (const page of pages) {
    const { width, height } = page.getSize();
    const turned = page.getRotation().angle % 180 !== 0;
    if (turned ? height > width : width > height) landscape++;
  }
  return { pageCount: pages.length, mostlyLandscape: landscape > pages.length / 2 };
}

/** Returns a new PDF containing only the given 1-based pages, in the given order. */
export async function selectPages(bytes: Buffer, pages: number[]): Promise<Buffer> {
  const source = await load(bytes);
  const total = source.getPageCount();
  if (pages.length === 0 || pages.some((p) => !Number.isInteger(p) || p < 1 || p > total)) {
    throw new ProcessingError('corrupt_file', 'Invalid page selection');
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((p) => p - 1),
  );
  for (const page of copied) out.addPage(page);
  return Buffer.from(await out.save());
}

export interface NupGrid {
  sheetW: number;
  sheetH: number;
  cols: number;
  rows: number;
}

const SHEET_MARGIN = 14;
const CELL_GAP = 8;

/**
 * Places several source pages on each sheet, left to right then top to bottom. Every page is
 * scaled to fit its cell with its proportions kept and is centred, so nothing is cut off.
 * Done here rather than with Ghostscript's N-up, which misplaces content when the sheet is
 * turned relative to the pages.
 */
export async function layoutNup(bytes: Buffer, grid: NupGrid): Promise<Buffer> {
  const source = await load(bytes);
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(source.getPages());
  const perSheet = grid.cols * grid.rows;

  const cellW = (grid.sheetW - 2 * SHEET_MARGIN - (grid.cols - 1) * CELL_GAP) / grid.cols;
  const cellH = (grid.sheetH - 2 * SHEET_MARGIN - (grid.rows - 1) * CELL_GAP) / grid.rows;

  for (let start = 0; start < embedded.length; start += perSheet) {
    const sheet = out.addPage([grid.sheetW, grid.sheetH]);
    for (let slot = 0; slot < perSheet && start + slot < embedded.length; slot++) {
      const page = embedded[start + slot]!;
      const turn = ((source.getPage(start + slot).getRotation().angle % 360) + 360) % 360;
      const sideways = turn === 90 || turn === 270;
      // Size as displayed, after the page's own rotation.
      const w = sideways ? page.height : page.width;
      const h = sideways ? page.width : page.height;
      const scale = Math.min(cellW / w, cellH / h);
      const shownW = w * scale;
      const shownH = h * scale;

      const col = slot % grid.cols;
      const row = Math.floor(slot / grid.cols);
      const x = SHEET_MARGIN + col * (cellW + CELL_GAP) + (cellW - shownW) / 2;
      const y =
        grid.sheetH - SHEET_MARGIN - (row + 1) * cellH - row * CELL_GAP + (cellH - shownH) / 2;

      // pdf-lib rotates counter-clockwise about the origin; PDF page rotation is clockwise.
      const placement = {
        0: { rotate: 0, dx: 0, dy: 0 },
        90: { rotate: -90, dx: 0, dy: page.width * scale },
        180: { rotate: 180, dx: shownW, dy: shownH },
        270: { rotate: 90, dx: shownH, dy: 0 },
      }[turn as 0 | 90 | 180 | 270] ?? { rotate: 0, dx: 0, dy: 0 };

      sheet.drawPage(page, {
        x: x + placement.dx,
        y: y + placement.dy,
        xScale: scale,
        yScale: scale,
        rotate: degrees(placement.rotate),
      });
    }
  }
  return Buffer.from(await out.save());
}
