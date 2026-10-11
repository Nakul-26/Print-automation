# ADR 0004: Document pipeline

Status: accepted (2026-10-11)

## Flow

1. `POST /api/v1/shops/:slug/uploads` (public, rate-limited): multer streams the file to a temp directory with a server-generated name and a hard size limit. The type is sniffed from the file's **bytes** (never the name or client MIME type); unsupported types are rejected before anything is stored. The original is moved into storage under a server-generated key, a row is created (`processing`), and a job is queued.
2. A background job (pg-boss on PostgreSQL) normalises the document into a clean PDF and counts pages: PDFs are rewritten by Ghostscript (`-dSAFER`; strips scripts, launch actions, embedded files), images are re-encoded by sharp (applies EXIF rotation, strips metadata) and placed on an A4 page. Failures set `failed` with a student-friendly message and delete the files.
3. The student polls `GET /uploads/:token` and previews `GET /uploads/:token/preview`. The token is a 192-bit secret shown once; only its HMAC is stored. `DELETE /uploads/:token` discards the upload and its files immediately.
4. At order time, `buildPrintPdf` produces the exact PDF to print: selected pages, N-up layout (2 or 4 pages per sheet, orientation-aware), and **true grayscale** for black-and-white jobs. Copies and duplex are applied by the printer/agent.

## Decisions

- **Ghostscript runs over stdin/stdout** via a configurable command (`GS_COMMAND`): a native `gs` in production images and CI, and `docker exec -i print-tools gs` on a Windows dev machine. No shared temp files, identical behaviour everywhere. Ghostscript exits 0 on unreadable input, so failures are recognised from its log.
- **qpdf was dropped**: `pdf-lib` covers page selection and inspection in JavaScript.
- Office documents are detected and politely refused until Phase 3 (LibreOffice conversion with settings and preview).
- Storage keys are server-generated and validated (`LocalDiskStorage` rejects anything that could escape its root). Files are never served statically.
- Uploads expire 24 hours after creation (`expires_at`); the retention/eviction job arrives in Phase 6. A simple storage-limit check already refuses uploads when `STORAGE_MAX_BYTES` would be exceeded.
- Limits: `MAX_UPLOAD_BYTES` (20 MB), `MAX_PDF_PAGES` (500), 100 megapixels per image, `GS_TIMEOUT_MS` per Ghostscript run, `UPLOAD_RATE_LIMIT_MAX` uploads per IP per 15 minutes.
