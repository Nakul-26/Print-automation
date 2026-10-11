import { fileTypeFromBuffer } from 'file-type';
import type { OfficeFamily } from '@print/contracts';

export type DocumentKind = 'pdf' | 'image' | 'office' | 'legacy_office' | 'unknown';

export interface DetectedType {
  kind: DocumentKind;
  /** Detected from the file's bytes, never from the client-supplied name or MIME type. */
  mime: string;
  /** Safe extension chosen by us for storage keys. */
  ext: string;
  /** For Office documents: which LibreOffice application converts it. */
  family?: OfficeFamily;
}

const IMAGE_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const OFFICE_TYPES = new Map<string, { ext: string; family: OfficeFamily }>([
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { ext: 'docx', family: 'writer' },
  ],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    { ext: 'pptx', family: 'impress' },
  ],
  [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    { ext: 'xlsx', family: 'calc' },
  ],
  ['application/vnd.oasis.opendocument.text', { ext: 'odt', family: 'writer' }],
  ['application/vnd.oasis.opendocument.presentation', { ext: 'odp', family: 'impress' }],
  ['application/vnd.oasis.opendocument.spreadsheet', { ext: 'ods', family: 'calc' }],
]);

/**
 * Old binary Office files (.doc/.xls/.ppt) share one container format, so the type cannot be
 * told from the first bytes; they are refused with a hint to re-save in a modern format.
 */
const LEGACY_OFFICE_MIMES = new Set([
  'application/x-cfb',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

/**
 * Identifies a document from its leading bytes. Give it up to ~512 KB: ZIP-based Office files
 * list their parts near the start, and the first entries can be large.
 */
export async function detectType(head: Uint8Array): Promise<DetectedType> {
  const found = await fileTypeFromBuffer(head);
  const mime = found?.mime ?? 'application/octet-stream';

  if (mime === 'application/pdf') return { kind: 'pdf', mime, ext: 'pdf' };
  const image = IMAGE_TYPES.get(mime);
  if (image) return { kind: 'image', mime, ext: image };
  const office = OFFICE_TYPES.get(mime);
  if (office) return { kind: 'office', mime, ext: office.ext, family: office.family };
  if (LEGACY_OFFICE_MIMES.has(mime)) return { kind: 'legacy_office', mime, ext: 'bin' };
  return { kind: 'unknown', mime, ext: 'bin' };
}
