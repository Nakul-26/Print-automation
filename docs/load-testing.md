# Load testing and sizing the workers

Goal: find how many students can upload at once on **your** server before waiting gets long, and
choose `WORKER_REPLICAS` from a measurement (see `docs/adr/0009-burst-capacity.md` for why more
workers than spare CPU cores makes things slower).

## Run it (against staging, never production)

1. In the staging Dokploy environment add, temporarily:
   `UPLOAD_RATE_LIMIT_MAX=100000` and `API_RATE_LIMIT_MAX=1000000` (the real per-visitor limits would
   otherwise block a test that sends everything from one connection). Redeploy staging.
2. Create a staging shop (apply at `/apply`, approve in `/admin`) and note its slug.
3. From any computer with Node 22 and this repository:
   ```
   cd apps/api
   node scripts/load-test.mjs --base https://print-staging.fiveorbit.tech \
        --shop <slug> --students 60 --over 10 --pages 15 --preview
   ```
   `--students` students arrive within `--over` seconds; each uploads a PDF (every 7th is 3× longer)
   and waits until it is ready, then (with `--preview`) downloads the preview.
4. Watch the server while it runs: `docker stats`.
5. Remove the two temporary variables and redeploy staging.

## Reading the result

- **95th-percentile "time until ready"** is what the unluckiest student waits. Under about 15 s for a
  rush of the size you expect is comfortable; each extra worker only helps if CPU is left.
- **"most files ahead of someone"** is what students see as "N files are ahead of yours".
- Any `upload HTTP 5xx`, `processing failed` or `not ready in time` line is a defect, not a capacity
  number: investigate before changing anything.
- `preview busy (503, client retries)` is the preview gate doing its job; many of them means previews
  are the bottleneck (see `PREVIEW_CONCURRENCY`).

## Choosing the numbers

Start with `WORKER_REPLICAS=1` (the default). Run a test at roughly 2× the biggest rush you expect
(for a school gate: maybe 60–100 students in a minute). If the 95th percentile is too long **and**
`docker stats` shows spare CPU (the server is well under 100% on all cores), try
`WORKER_REPLICAS=2`, rerun, and keep it only if the result clearly improved. Stop when CPU is full:
beyond that you gain nothing. Record the result below.

## Results

| Date       | Machine                                   | Burst                                   | 95th pct ready       | Notes                                                              |
| ---------- | ----------------------------------------- | --------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| 2026-10-12 | Developer PC, production images, 1 worker | 150 students in 6 s, 30 pages, previews | 19 s, all 150 served | Baseline only. The worker planned 1 job at a time on this machine. |
| 2026-10-12 | same                                      | 40 students in 10 s, 12 pages           | 1.5 s                |                                                                    |
| _pending_  | **Your Linux server, staging**            |                                         |                      | Run before the pilot.                                              |

The first row proves the system queues a burst correctly and serves everyone (a single connection hit
the per-visitor limit first, as designed). It says nothing about your server's speed; the last row
is the one that sets the worker count.
