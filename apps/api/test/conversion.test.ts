import { beforeAll, describe, expect, it } from 'vitest';
import { createConversion, ProcessingError } from '../src/modules/conversion/index.js';
import {
  CORRUPT_PDF,
  FAKE_EXE,
  GS_COMMAND,
  gsAvailable,
  LEGACY_OFFICE,
  makeDocx,
  makePptx,
  makeXlsx,
  OFFICE_COMMAND,
  officeAvailable,
  makeEncryptedPdf,
  makePdf,
  makePng,
  makeRotatedJpeg,
  inkBounds,
  makeFramedPdf,
  pdfInfo,
  renderPng,
  renderMeans,
} from './fixtures.js';

const conversion = createConversion({
  gs: { command: GS_COMMAND, timeoutMs: 60_000 },
  office: { command: OFFICE_COMMAND, timeoutMs: 120_000 },
  maxPages: 10,
});

let gsOk = false;
let officeOk = false;
beforeAll(async () => {
  gsOk = await gsAvailable();
  officeOk = await officeAvailable();
  if (!officeOk) console.warn('LibreOffice unavailable; skipping Office conversion tests');
  if (!gsOk)
    console.warn(`Ghostscript unavailable (GS_COMMAND="${GS_COMMAND}"); skipping gs tests`);
});

/** Skips when Ghostscript is not reachable (e.g. the tools container is not running). */
const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!gsOk) ctx.skip();
    await fn();
  });

const officeIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!officeOk) ctx.skip();
    await fn();
  });

describe('detectType', () => {
  it('identifies types from bytes, ignoring names', async () => {
    expect((await conversion.detectType(await makePdf(1))).kind).toBe('pdf');
    expect((await conversion.detectType(await makePng())).kind).toBe('image');
    expect((await conversion.detectType(await makeRotatedJpeg())).kind).toBe('image');
    expect((await conversion.detectType(FAKE_EXE)).kind).toBe('unknown');
    expect((await conversion.detectType(Buffer.from('just some text'))).kind).toBe('unknown');
  });
});

describe('normalize', () => {
  gsIt('re-writes a PDF and reports its page count', async () => {
    const detected = await conversion.detectType(await makePdf(3));
    const result = await conversion.normalize(await makePdf(3), detected);
    expect(result.pageCount).toBe(3);
    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('turns an image into a one-page A4 PDF', async () => {
    const png = await makePng();
    const result = await conversion.normalize(png, await conversion.detectType(png));
    expect(result.pageCount).toBe(1);
    expect((await pdfInfo(result.pdf)).sizes).toEqual(['842x595']); // wide image -> landscape A4
  });

  it('applies EXIF rotation so phone photos are upright', async () => {
    const jpeg = await makeRotatedJpeg();
    const result = await conversion.normalize(jpeg, await conversion.detectType(jpeg));
    expect((await pdfInfo(result.pdf)).sizes).toEqual(['595x842']); // stored 200x100, shown 100x200
  });

  it('rejects documents over the page limit', async () => {
    const pdf = await makePdf(11);
    await expect(conversion.normalize(pdf, await conversion.detectType(pdf))).rejects.toMatchObject(
      {
        code: 'too_many_pages',
      },
    );
  });

  gsIt('rejects password-protected PDFs with a clear message', async () => {
    const pdf = await makeEncryptedPdf();
    const err = await conversion
      .normalize(pdf, await conversion.detectType(pdf))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProcessingError);
    expect(err).toMatchObject({ code: 'encrypted_pdf' });
    expect((err as Error).message).toMatch(/password/i);
  });

  gsIt('rejects damaged PDFs', async () => {
    await expect(
      conversion.normalize(CORRUPT_PDF, { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' }),
    ).rejects.toBeInstanceOf(ProcessingError);
  });

  it('rejects unknown files and legacy Office files with a helpful message', async () => {
    await expect(
      conversion.normalize(FAKE_EXE, { kind: 'unknown', mime: 'x', ext: 'bin' }),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
    const legacy = await conversion.detectType(LEGACY_OFFICE);
    expect(legacy.kind).toBe('legacy_office');
    await expect(conversion.normalize(LEGACY_OFFICE, legacy)).rejects.toThrow(/.docx/);
  });
});

describe('buildPrintPdf', () => {
  const base = { paperSize: 'A4', pagesPerSheet: 1, colorMode: 'color' } as const;

  it('returns the source untouched for colour, 1-up, all pages', async () => {
    const source = await makePdf(3);
    expect(await conversion.buildPrintPdf({ ...base, source })).toBe(source);
  });

  it('keeps only the selected pages, in order', async () => {
    const source = await makePdf(5);
    const out = await conversion.buildPrintPdf({ ...base, source, pages: [5, 1, 3] });
    expect((await pdfInfo(out)).count).toBe(3);
  });

  it('rejects out-of-range page selections', async () => {
    const source = await makePdf(2);
    await expect(conversion.buildPrintPdf({ ...base, source, pages: [3] })).rejects.toBeInstanceOf(
      ProcessingError,
    );
  });

  gsIt('produces truly grayscale output for black-and-white jobs', async () => {
    const source = await makePdf(1);
    const [r, g, b] = await renderMeans(source);
    expect(Math.abs(r - b)).toBeGreaterThan(5); // the source really is coloured

    const gray = await conversion.buildPrintPdf({ ...base, source, colorMode: 'black_white' });
    const [gr, gg, gb] = await renderMeans(gray);
    expect(gr).toBeCloseTo(gg, 0);
    expect(gg).toBeCloseTo(gb, 0);
    expect(g).toBeGreaterThan(0);
  });

  gsIt('keeps colour for colour jobs that need n-up', async () => {
    const source = await makePdf(2);
    const out = await conversion.buildPrintPdf({ ...base, source, pagesPerSheet: 2 });
    const [r, , b] = await renderMeans(out);
    expect(Math.abs(r - b)).toBeGreaterThan(2);
  });

  gsIt('never clips the edges of pages placed 2-up or 4-up', async () => {
    const margin = 5; // px at 40 dpi, a little less than the 14pt sheet margin
    const check = async (out: Buffer, w: number, h: number) => {
      const b = await inkBounds(await renderPng(out));
      expect(b.width).toBe(w);
      expect(b.height).toBe(h);
      expect(b.x0).toBeGreaterThanOrEqual(margin);
      expect(b.y0).toBeGreaterThanOrEqual(margin);
      expect(b.x1).toBeLessThanOrEqual(b.width - 1 - margin);
      expect(b.y1).toBeLessThanOrEqual(b.height - 1 - margin);
      // ...and the frames are really drawn near the sheet edges (content not shrunk away).
      expect(b.y1 - b.y0).toBeGreaterThan(h * 0.8);
      expect(b.x1 - b.x0).toBeGreaterThan(w * 0.8);
    };
    const portrait = await makeFramedPdf(4);
    await check(
      await conversion.buildPrintPdf({ ...base, source: portrait, pagesPerSheet: 2 }),
      468,
      331,
    );
    await check(
      await conversion.buildPrintPdf({ ...base, source: portrait, pagesPerSheet: 4 }),
      331,
      468,
    );
    // Landscape pages stack on a portrait sheet.
    const landscape = await makeFramedPdf(2, [842, 595]);
    await check(
      await conversion.buildPrintPdf({ ...base, source: landscape, pagesPerSheet: 2 }),
      331,
      468,
    );
  });

  gsIt('lays portrait pages 2-up on landscape sheets', async () => {
    const out = await conversion.buildPrintPdf({
      ...base,
      source: await makePdf(4),
      pagesPerSheet: 2,
    });
    expect(await pdfInfo(out)).toEqual({ count: 2, sizes: ['842x595', '842x595'] });
  });

  gsIt('lays portrait pages 4-up on portrait sheets, and counts partial sheets', async () => {
    const full = await conversion.buildPrintPdf({
      ...base,
      source: await makePdf(4),
      pagesPerSheet: 4,
    });
    expect(await pdfInfo(full)).toEqual({ count: 1, sizes: ['595x842'] });
    const partial = await conversion.buildPrintPdf({
      ...base,
      source: await makePdf(5),
      pagesPerSheet: 4,
    });
    expect((await pdfInfo(partial)).count).toBe(2);
  });

  gsIt('lays landscape pages 2-up on portrait sheets', async () => {
    const out = await conversion.buildPrintPdf({
      ...base,
      source: await makePdf(2, { landscape: true }),
      pagesPerSheet: 2,
    });
    expect(await pdfInfo(out)).toEqual({ count: 1, sizes: ['595x842'] });
  });

  gsIt('uses A3 sheets when A3 is requested', async () => {
    const out = await conversion.buildPrintPdf({
      ...base,
      paperSize: 'A3',
      source: await makePdf(2),
      pagesPerSheet: 2,
    });
    expect((await pdfInfo(out)).sizes).toEqual(['1191x842']);
  });

  gsIt('combines page selection, n-up, and grayscale', async () => {
    const out = await conversion.buildPrintPdf({
      ...base,
      colorMode: 'black_white',
      source: await makePdf(6),
      pages: [1, 2, 3, 4],
      pagesPerSheet: 2,
    });
    expect((await pdfInfo(out)).count).toBe(2);
    const [r, , b] = await renderMeans(out);
    expect(r).toBeCloseTo(b, 0);
  });
});

describe('Office conversion', () => {
  const writer = (over: Record<string, unknown> = {}) => ({
    paperSize: 'A4',
    orientation: 'auto',
    margins: 'document',
    ...over,
  });

  async function convert(file: Buffer, settings?: Record<string, unknown>) {
    const detected = await conversion.detectType(file);
    const result = await conversion.normalize(file, detected, settings as never);
    return { detected, ...result, info: await pdfInfo(result.pdf) };
  }

  officeIt('detects the three Office families from their bytes', async () => {
    expect((await conversion.detectType(await makeDocx(1))).family).toBe('writer');
    expect((await conversion.detectType(await makeXlsx())).family).toBe('calc');
    expect((await conversion.detectType(await makePptx())).family).toBe('impress');
  });

  officeIt('converts a Word document onto A4 by default', async () => {
    const out = await convert(await makeDocx(), writer());
    expect(out.pageCount).toBeGreaterThanOrEqual(2);
    expect(new Set(out.info.sizes)).toEqual(new Set(['595x842']));
  });

  officeIt('re-flows a Word document onto A3, landscape, or without margins', async () => {
    const docx = await makeDocx();
    const a4 = await convert(docx, writer());
    const a3 = await convert(docx, writer({ paperSize: 'A3' }));
    expect(new Set(a3.info.sizes)).toEqual(new Set(['842x1191']));
    expect(a3.pageCount).toBeLessThan(a4.pageCount);

    const landscape = await convert(docx, writer({ orientation: 'landscape' }));
    expect(new Set(landscape.info.sizes)).toEqual(new Set(['842x595']));

    const noMargins = await convert(docx, writer({ margins: 'none' }));
    expect(noMargins.pageCount).toBeLessThanOrEqual(a4.pageCount);
  });

  officeIt('scales a wide spreadsheet according to the fit option', async () => {
    const xlsx = await makeXlsx();
    const calc = (fit: string) => ({
      paperSize: 'A4',
      orientation: 'auto',
      margins: 'document',
      fit,
      gridlines: false,
    });
    const actual = await convert(xlsx, calc('actual'));
    const fitWidth = await convert(xlsx, calc('fit_width'));
    const onePage = await convert(xlsx, calc('one_page_per_sheet'));
    expect(actual.pageCount).toBeGreaterThan(fitWidth.pageCount);
    expect(onePage.pageCount).toBe(1);
  });

  officeIt('exports slides, hidden slides, and notes pages as requested', async () => {
    const pptx = await makePptx();
    const base = { includeNotes: false, includeHiddenSlides: false };
    const slides = await convert(pptx, base);
    expect(slides.pageCount).toBe(2); // slide 2 is hidden
    expect(slides.info.sizes[0]!.split('x').map(Number)[0]).toBeGreaterThan(
      slides.info.sizes[0]!.split('x').map(Number)[1]!,
    ); // slides are landscape

    const withHidden = await convert(pptx, { ...base, includeHiddenSlides: true });
    expect(withHidden.pageCount).toBe(3);

    const notes = await convert(pptx, { ...base, includeNotes: true });
    const [w, h] = notes.info.sizes[0]!.split('x').map(Number);
    expect(h).toBeGreaterThan(w!); // notes pages are portrait
  });

  officeIt('rejects a damaged Office file cleanly', async () => {
    const good = await makeDocx(5);
    const damaged = good.subarray(0, Math.floor(good.length / 2));
    const detected = { kind: 'office', family: 'writer', ext: 'docx', mime: 'x' } as const;
    await expect(conversion.normalize(damaged, detected)).rejects.toMatchObject({
      code: 'corrupt_file',
    });
  });
});
