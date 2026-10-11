# ADR 0005: Office conversion and containerised deployment

Status: accepted (2026-10-11)

## Office conversion

- Supported: `.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp`, `.ods`, detected from the file's bytes. Old binary `.doc`/`.xls`/`.ppt` share one container format and cannot be told apart reliably, so they are refused with advice to re-save as a modern format or export a PDF.
- `infra/office/convert.py` starts a **fresh LibreOffice per conversion** (own profile directory, own socket), loads the document with macros disabled and link updates off, applies the student's settings through the UNO API, exports a PDF, and cleans up. It has its own watchdog so it never leaves LibreOffice processes behind. Contract: document on stdin, PDF on stdout, errors as `PP_ERROR:<code>` on stderr.
- Like Ghostscript, it is run through a configurable command (`OFFICE_COMMAND`): `python3 /opt/print-convert/convert.py` in the production image and CI, `docker exec -i print-tools python3 ...` on a Windows dev machine.
- Settings (validated per family in `packages/contracts`): Word/ODT = paper size, orientation, margins; Excel/ODS = the same plus fit (actual size / fit width / one page per sheet) and gridlines; PowerPoint/ODP = include notes pages, include hidden slides. Slides-per-sheet is a print setting (N-up) applied later by Ghostscript.
- Flow: upload converts with defaults; `POST /uploads/:token/conversion` changes settings and queues a re-conversion. Each distinct settings combination is kept as a **variant**, so switching back is instant. Jobs carry a **revision** number; a job overtaken by newer settings is ignored. If a settings change cannot be converted, the previous preview stays usable and its settings are restored, with an explanatory message.
- All variants count toward storage and are deleted together with the upload.
- Known limitations: fonts missing from the image are substituted (the image ships Liberation, Carlito, Caladea, DejaVu and Noto, which are metric-compatible with common Microsoft fonts), so layout can differ from Word; the UI should always offer "for exact results, upload a PDF". LibreOffice runs in the same container as the API; for stricter isolation a later step is a dedicated worker container with no outbound network access (documents can reference external images).

## Containers

- Production = three services: `web` (nginx serving the built React app and proxying `/api` and `/socket.io` to `api`, so browser and API share one origin), `api` (Node + Ghostscript + LibreOffice, runs `prisma migrate deploy` on start), and `postgres`. Defined in `infra/compose.prod.yaml` for Dokploy; domains attach to `web:80`.
- Everyday development stays native (`pnpm dev`) with PostgreSQL and the tools container in Docker. `infra/compose.prod.local.yaml` runs the production images locally on port 8080.
- Images run as non-root, have health checks, and keep state only in two volumes: `pgdata` and `files` (`/data`). CI builds both images on every change.
