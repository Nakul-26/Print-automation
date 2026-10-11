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

/** Mean R/G/B of page 1 rendered at low resolution. Equal means are the signature of gray. */
export async function renderMeans(pdf: Buffer, page = 1): Promise<[number, number, number]> {
  const [bin, ...prefix] = GS_COMMAND.split(/\s+/);
  const png = await new Promise<Buffer>((resolve, reject) => {
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
