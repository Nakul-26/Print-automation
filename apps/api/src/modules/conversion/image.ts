import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { ProcessingError } from './errors.js';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 18; // points
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_SIDE_PX = 3508; // A4 long side at 300 dpi

/**
 * Turns a photo or scan into a one-page A4 PDF.
 * Re-encoding through sharp also applies EXIF rotation (phone photos) and strips metadata
 * and any embedded payloads.
 */
export async function imageToPdf(bytes: Buffer): Promise<Buffer> {
  let jpeg: Buffer;
  let width: number;
  let height: number;
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    jpeg = data;
    width = info.width;
    height = info.height;
  } catch (err) {
    const tooBig = err instanceof Error && /pixel limit/i.test(err.message);
    throw new ProcessingError(
      tooBig ? 'image_too_large' : 'corrupt_file',
      tooBig
        ? 'This image is too large. Upload a smaller photo or scan.'
        : 'This image could not be read. Try saving it again as JPG or PNG.',
      { cause: err },
    );
  }

  const landscape = width > height;
  const pageW = landscape ? A4.height : A4.width;
  const pageH = landscape ? A4.width : A4.height;
  const scale = Math.min((pageW - 2 * MARGIN) / width, (pageH - 2 * MARGIN) / height);
  const drawW = width * scale;
  const drawH = height * scale;

  const doc = await PDFDocument.create();
  const page = doc.addPage([pageW, pageH]);
  const image = await doc.embedJpg(jpeg);
  page.drawImage(image, {
    x: (pageW - drawW) / 2,
    y: (pageH - drawH) / 2,
    width: drawW,
    height: drawH,
  });
  return Buffer.from(await doc.save());
}
