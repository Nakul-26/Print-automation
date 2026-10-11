import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import multer, { MulterError } from 'multer';
import { UPLOAD_TOKEN_PATTERN, type CreateUploadResponse } from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import { toView, type UploadService } from '../service/upload-service.js';

export interface PublicShop {
  id: string;
  status: 'pending_approval' | 'active' | 'suspended';
}

/** Public, token-based routes used by students. No account is required. */
export function createUploadsRouter(deps: {
  uploads: UploadService;
  findShopBySlug: (slug: string) => Promise<PublicShop | null>;
  tempDir: string;
  maxUploadBytes: number;
  rateLimitMax: number;
}): Router {
  const router = Router();

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: deps.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many uploads, please wait a few minutes', 'rate_limited')),
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdir(deps.tempDir, { recursive: true }).then(
          () => cb(null, deps.tempDir),
          (err: Error) => cb(err, deps.tempDir),
        );
      },
      // Server-generated; the client's filename never touches the file system.
      filename: (_req, _file, cb) => cb(null, `${randomBytes(16).toString('hex')}.upload`),
    }),
    limits: { fileSize: deps.maxUploadBytes, files: 1, fields: 2, parts: 4 },
  }).single('file');

  const tokenParam = (value: unknown): string => {
    if (typeof value !== 'string' || !UPLOAD_TOKEN_PATTERN.test(value)) {
      throw new HttpError(404, 'Upload not found', 'not_found');
    }
    return value;
  };

  router.post('/shops/:slug/uploads', limiter, (req, res, next) => {
    upload(req, res, (err: unknown) => {
      void (async () => {
        const file = req.file;
        try {
          if (err instanceof MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
              const mb = Math.floor(deps.maxUploadBytes / (1024 * 1024));
              throw new HttpError(
                413,
                `The file is too large. The limit is ${mb} MB.`,
                'too_large',
              );
            }
            throw new HttpError(
              400,
              'Upload failed. Send one file in the "file" field.',
              'bad_upload',
            );
          }
          if (err) throw err;
          if (!file) throw new HttpError(400, 'No file was uploaded', 'no_file');

          const shop = await deps.findShopBySlug(String(req.params['slug']));
          if (!shop || shop.status !== 'active') {
            throw new HttpError(404, 'Shop not found', 'not_found');
          }

          const created = await deps.uploads.create({
            shopId: shop.id,
            tempPath: file.path,
            originalName: file.originalname,
            sizeBytes: file.size,
          });
          const body: CreateUploadResponse = {
            token: created.token,
            upload: toView(created.upload),
          };
          res.status(201).json(body);
        } catch (e) {
          if (file) await rm(file.path, { force: true });
          next(e);
        }
      })();
    });
  });

  router.get('/uploads/:token', async (req, res) => {
    const found = await deps.uploads.getByToken(tokenParam(req.params['token']));
    res.set('Cache-Control', 'no-store');
    res.json(toView(found));
  });

  router.get('/uploads/:token/preview', async (req, res) => {
    const { stream, size } = await deps.uploads.openPreview(tokenParam(req.params['token']));
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(size > 0 ? { 'Content-Length': String(size) } : {}),
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.delete('/uploads/:token', async (req, res) => {
    await deps.uploads.discard(tokenParam(req.params['token']));
    res.status(204).end();
  });

  return router;
}

export function uploadTempDir(storageRoot: string): string {
  return join(storageRoot, 'tmp');
}
