import { z } from 'zod';
import { OfficeFamily } from './office.js';

export const UploadStatus = z.enum(['processing', 'ready', 'failed']);
export type UploadStatus = z.infer<typeof UploadStatus>;

export const DocumentKind = z.enum(['pdf', 'image', 'office']);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** Public view of an upload; safe to show to the student who owns the access token. */
export const UploadView = z.object({
  id: z.uuid(),
  status: UploadStatus,
  originalName: z.string(),
  documentKind: DocumentKind,
  /** Set for Office documents; tells the UI which conversion options to offer. */
  officeFamily: OfficeFamily.nullable(),
  /** The conversion settings the current preview was made with (Office documents only). */
  conversionSettings: z.record(z.string(), z.unknown()).nullable(),
  /** Increments each time conversion settings change; lets the UI detect a finished re-conversion. */
  revision: z.number().int(),
  pageCount: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type UploadView = z.infer<typeof UploadView>;

export const CreateUploadResponse = z.object({
  /** Secret handle for this upload: poll status and preview with it. Shown only once. */
  token: z.string(),
  upload: UploadView,
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

export const UPLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
