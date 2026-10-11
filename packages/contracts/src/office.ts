import { z } from 'zod';
import { PaperSize } from './order.js';

/** Which LibreOffice application handles a document. */
export const OfficeFamily = z.enum(['writer', 'calc', 'impress']);
export type OfficeFamily = z.infer<typeof OfficeFamily>;

const pageSetup = {
  paperSize: PaperSize.default('A4'),
  orientation: z.enum(['auto', 'portrait', 'landscape']).default('auto'),
  margins: z.enum(['document', 'narrow', 'none']).default('document'),
};

/** Word / OpenDocument text: re-flow onto the chosen paper. */
export const WriterSettings = z.object(pageSetup).strict();

/** Excel / OpenDocument spreadsheet: choose how sheets are scaled onto pages. */
export const CalcSettings = z
  .object({
    ...pageSetup,
    fit: z.enum(['actual', 'fit_width', 'one_page_per_sheet']).default('fit_width'),
    gridlines: z.boolean().default(false),
  })
  .strict();

/** PowerPoint / OpenDocument presentation. Slides per sheet is chosen later as a print setting. */
export const ImpressSettings = z
  .object({
    includeNotes: z.boolean().default(false),
    includeHiddenSlides: z.boolean().default(false),
  })
  .strict();

export const OFFICE_SETTINGS_SCHEMAS = {
  writer: WriterSettings,
  calc: CalcSettings,
  impress: ImpressSettings,
} as const;

export type WriterSettings = z.infer<typeof WriterSettings>;
export type CalcSettings = z.infer<typeof CalcSettings>;
export type ImpressSettings = z.infer<typeof ImpressSettings>;
export type OfficeSettings = WriterSettings | CalcSettings | ImpressSettings;

export function defaultOfficeSettings(family: OfficeFamily): OfficeSettings {
  return OFFICE_SETTINGS_SCHEMAS[family].parse({});
}

/** Body of POST /uploads/:token/conversion. Validated against the document's family server-side. */
export const ConversionRequest = z.object({
  settings: z.record(z.string(), z.unknown()),
});
export type ConversionRequest = z.infer<typeof ConversionRequest>;
