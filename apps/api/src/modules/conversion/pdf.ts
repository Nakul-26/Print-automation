import { PDFDocument } from 'pdf-lib';
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
