import { fileTypeFromBuffer } from 'file-type';

export type DocumentKind = 'pdf' | 'image' | 'office' | 'unknown';

export interface DetectedType {
  kind: DocumentKind;
  /** Detected from the file's bytes, never from the client-supplied name or MIME type. */
  mime: string;
  /** Safe extension chosen by us for storage keys. */
  ext: string;
}

const IMAGE_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const OFFICE_TYPES = new Map<string, string>([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/msword', 'doc'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
]);

/** Identifies a document from its leading bytes (at least ~4 KB is enough). */
export async function detectType(head: Uint8Array): Promise<DetectedType> {
  const found = await fileTypeFromBuffer(head);
  const mime = found?.mime ?? 'application/octet-stream';

  if (mime === 'application/pdf') return { kind: 'pdf', mime, ext: 'pdf' };
  const image = IMAGE_TYPES.get(mime);
  if (image) return { kind: 'image', mime, ext: image };
  const office = OFFICE_TYPES.get(mime);
  if (office) return { kind: 'office', mime, ext: office };
  return { kind: 'unknown', mime, ext: 'bin' };
}
