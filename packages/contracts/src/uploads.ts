import { z } from 'zod';

export const UploadStatus = z.enum(['processing', 'ready', 'failed']);
export type UploadStatus = z.infer<typeof UploadStatus>;

/** Public view of an upload; safe to show to the student who owns the access token. */
export const UploadView = z.object({
  id: z.uuid(),
  status: UploadStatus,
  originalName: z.string(),
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
