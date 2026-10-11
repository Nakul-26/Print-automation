import { defaultOfficeSettings, type OfficeSettings } from '@print/contracts';
import { detectType, type DetectedType } from './detect.js';
import { ProcessingError } from './errors.js';
import { PREPRESS_ARGS, runGhostscript, type GhostscriptOptions } from './ghostscript.js';
import { imageToPdf } from './image.js';
import { convertOffice, type OfficeOptions } from './office.js';
import { inspectPdf } from './pdf.js';
import { buildPrintPdf, type PrintPdfRequest } from './print-pdf.js';

export { ProcessingError, type ProcessingErrorCode } from './errors.js';
export type { DetectedType, DocumentKind } from './detect.js';
export type { PrintPdfRequest } from './print-pdf.js';

export const UNSUPPORTED_LEGACY_MESSAGE =
  'Old Word, Excel and PowerPoint files (.doc, .xls, .ppt) are not supported. ' +
  'Save as .docx, .xlsx or .pptx, or export a PDF, and upload that.';

export interface NormalizedDocument {
  pdf: Buffer;
  pageCount: number;
}

export interface ConversionOptions {
  gs: GhostscriptOptions;
  office: OfficeOptions;
  maxPages: number;
}

/**
 * Document processing: type detection, normalising uploads into clean PDFs, and building
 * the final print PDF. Pure processing with no database or HTTP knowledge.
 */
export function createConversion(options: ConversionOptions) {
  const { gs, office, maxPages } = options;

  return {
    detectType,

    /**
     * Turns an uploaded file into a sanitised, print-ready PDF.
     * PDFs are re-written by Ghostscript, which strips scripts, launch actions, and embedded
     * files; images are re-encoded and placed on an A4 page; Office documents are converted by
     * LibreOffice using `officeSettings` (defaults if omitted).
     */
    async normalize(
      bytes: Buffer,
      detected: DetectedType,
      officeSettings?: OfficeSettings,
    ): Promise<NormalizedDocument> {
      let pdf: Buffer;
      if (detected.kind === 'pdf') {
        pdf = (await runGhostscript(gs, PREPRESS_ARGS, bytes)).output;
        if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          throw new ProcessingError('corrupt_file', 'This file could not be read as a PDF');
        }
      } else if (detected.kind === 'image') {
        pdf = await imageToPdf(bytes);
      } else if (detected.kind === 'office' && detected.family) {
        pdf = await convertOffice(office, {
          bytes,
          family: detected.family,
          ext: detected.ext,
          settings: officeSettings ?? defaultOfficeSettings(detected.family),
        });
      } else if (detected.kind === 'legacy_office') {
        throw new ProcessingError('unsupported_type', UNSUPPORTED_LEGACY_MESSAGE);
      } else {
        throw new ProcessingError(
          'unsupported_type',
          'This file type is not supported. Upload a PDF, Word, PowerPoint, Excel, JPG or PNG file.',
        );
      }
      const info = await inspectPdf(pdf, maxPages);
      return { pdf, pageCount: info.pageCount };
    },

    buildPrintPdf: (request: PrintPdfRequest): Promise<Buffer> =>
      buildPrintPdf(gs, maxPages, request),

    /** Throws if Ghostscript cannot be started; used for the readiness probe. */
    async checkTools(): Promise<void> {
      const empty =
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\ntrailer<</Root 1 0 R>>\n';
      await runGhostscript({ ...gs, timeoutMs: 15_000 }, [], Buffer.from(empty));
    },
  };
}

export type Conversion = ReturnType<typeof createConversion>;
