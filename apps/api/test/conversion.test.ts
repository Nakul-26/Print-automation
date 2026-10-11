import { beforeAll, describe, expect, it } from 'vitest';
import { createConversion, ProcessingError } from '../src/modules/conversion/index.js';
import {
  CORRUPT_PDF,
  FAKE_EXE,
  GS_COMMAND,
  gsAvailable,
  makeEncryptedPdf,
  makePdf,
  makePng,
  makeRotatedJpeg,
  pdfInfo,
  renderMeans,
} from './fixtures.js';

const conversion = createConversion({
  gs: { command: GS_COMMAND, timeoutMs: 60_000 },
  maxPages: 10,
});

let gsOk = false;
beforeAll(async () => {
  gsOk = await gsAvailable();
  if (!gsOk)
    console.warn(`Ghostscript unavailable (GS_COMMAND="${GS_COMMAND}"); skipping gs tests`);
});

/** Skips when Ghostscript is not reachable (e.g. the tools container is not running). */
const gsIt = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!gsOk) ctx.skip();
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

  it('rejects unknown and (for now) Office files', async () => {
    await expect(
      conversion.normalize(FAKE_EXE, { kind: 'unknown', mime: 'x', ext: 'bin' }),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
    await expect(
      conversion.normalize(Buffer.from('x'), { kind: 'office', mime: 'x', ext: 'docx' }),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
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
