import { spawn } from 'node:child_process';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { runGhostscript } from '../src/modules/conversion/ghostscript.js';

export const GS_COMMAND = process.env['GS_COMMAND'] ?? 'gs';

/** A PDF with `pages` portrait A4 pages containing red and blue content. */
export async function makePdf(pages: number, opts: { landscape?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = opts.landscape ? doc.addPage([841.89, 595.28]) : doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 50, y: 300, width: 300, height: 200, color: rgb(1, 0, 0) });
    page.drawText(`Page ${i}`, { x: 60, y: 520, size: 40, font, color: rgb(0, 0, 1) });
  }
  return Buffer.from(await doc.save());
}

/** A phone-style JPEG: stored 200x100 with EXIF orientation 6 (displays as 100x200). */
export function makeRotatedJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 100, channels: 3, background: '#cc3322' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

export function makePng(width = 120, height = 80): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 120, b: 200, alpha: 0.5 } },
  })
    .png()
    .toBuffer();
}

/** Password-protected PDF, produced with Ghostscript. */
export async function makeEncryptedPdf(): Promise<Buffer> {
  const source = await makePdf(1);
  const { output } = await runGhostscript(
    { command: GS_COMMAND, timeoutMs: 30_000 },
    ['-sOwnerPassword=owner', '-sUserPassword=user', '-dEncryptionR=3', '-dKeyLength=128'],
    source,
  );
  return output;
}

export const CORRUPT_PDF = Buffer.from('%PDF-1.4\nthis is not really a pdf \x00\x01\x02 garbage');
export const FAKE_EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);

/** A page rendered to PNG at low resolution. */
export async function renderPng(pdf: Buffer, page = 1): Promise<Buffer> {
  const [bin, ...prefix] = GS_COMMAND.split(/\s+/);
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      bin!,
      [
        ...prefix,
        '-q',
        '-dBATCH',
        '-dNOPAUSE',
        '-dSAFER',
        '-sDEVICE=png16m',
        '-r40',
        `-dFirstPage=${page}`,
        `-dLastPage=${page}`,
        '-sOutputFile=-',
        '-',
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`gs exited ${code}`)),
    );
    child.stdin.end(pdf);
  });
}

/** Mean R/G/B of a page rendered at low resolution. Equal means are the signature of gray. */
export async function renderMeans(pdf: Buffer, page = 1): Promise<[number, number, number]> {
  const png = await renderPng(pdf, page);
  const { channels } = await sharp(png).stats();
  return [channels[0]!.mean, channels[1]!.mean, channels[2]!.mean];
}

export async function pdfInfo(pdf: Buffer): Promise<{ count: number; sizes: string[] }> {
  const doc = await PDFDocument.load(pdf);
  return {
    count: doc.getPageCount(),
    sizes: doc.getPages().map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`),
  };
}

export async function gsAvailable(): Promise<boolean> {
  try {
    await runGhostscript({ command: GS_COMMAND, timeoutMs: 20_000 }, [], await makePdf(1));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Office fixtures
// ---------------------------------------------------------------------------------------

export const OFFICE_COMMAND =
  process.env['OFFICE_COMMAND'] ?? 'python3 /opt/print-convert/convert.py';

/** A text document that runs to several A4 pages. */
export async function makeDocx(paragraphs = 120): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  const children = Array.from(
    { length: paragraphs },
    (_, i) =>
      new Paragraph({
        children: [
          new TextRun(`Line ${i + 1}: The quick brown fox jumps over the lazy dog. `.repeat(2)),
        ],
      }),
  );
  return Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

/** One wide sheet (25 columns), so "actual size" spills across several pages. */
export async function makeXlsx(): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  for (let r = 1; r <= 30; r++) {
    ws.addRow(Array.from({ length: 25 }, (_, c) => `R${r}C${c + 1} some text`));
  }
  for (let c = 1; c <= 25; c++) ws.getColumn(c).width = 14;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Three slides: the second is hidden; every slide has speaker notes. */
export async function makePptx(): Promise<Buffer> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const pptx = new PptxGenJS();
  for (let i = 1; i <= 3; i++) {
    const slide = pptx.addSlide();
    slide.addText(`Slide ${i}`, { x: 1, y: 1, fontSize: 32 });
    slide.addNotes(`Notes for slide ${i}`);
    if (i === 2) (slide as unknown as { hidden: boolean }).hidden = true;
  }
  return Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

/** The header of an old binary Office file (.doc/.xls/.ppt share this container). */
export const LEGACY_OFFICE = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(600),
]);

export async function officeAvailable(): Promise<boolean> {
  try {
    const { convertOffice } = await import('../src/modules/conversion/office.js');
    await convertOffice(
      { command: OFFICE_COMMAND, timeoutMs: 60_000 },
      {
        bytes: await makeDocx(1),
        family: 'writer',
        ext: 'docx',
        settings: { paperSize: 'A4', orientation: 'auto', margins: 'document' },
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Pages whose only content is a thick black frame on the very edge, so any clipping shows up. */
export async function makeFramedPdf(
  pages: number,
  size: [number, number] = [595, 842],
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const [w, h] = size;
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([w, h]);
    const t = 10;
    for (const [x, y, rw, rh] of [
      [0, 0, w, t],
      [0, h - t, w, t],
      [0, 0, t, h],
      [w - t, 0, t, h],
    ] as const) {
      page.drawRectangle({ x, y, width: rw, height: rh, color: rgb(0, 0, 0) });
    }
  }
  return Buffer.from(await doc.save());
}

/** Bounding box (in pixels) of everything darker than light gray, plus the image size. */
export async function inkBounds(png: Buffer) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width;
  let y0 = info.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels]! < 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { x0, y0, x1, y1, width: info.width, height: info.height };
}
