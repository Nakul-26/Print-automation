# 0009. Burst capacity: separate workers, bounded concurrency, no autoscaling (yet)

Status: accepted

## Problem

Near schools and colleges many students upload at the same moment. Preparing a file is CPU- and
memory-heavy (Ghostscript for PDFs, LibreOffice for Word/Excel/PowerPoint, plus the print
preview). More concurrent work than the machine can serve makes every job slower, so "more
workers" only helps up to what the server's cores and memory allow.

## Decisions

1. **One image, three roles (`APP_ROLE`).** `all` (default, dev and tests) does everything in one
   process. In production, `api` serves HTTP and sockets and only enqueues jobs; `worker` runs the
   queue and serves only `/health`. Heavy conversions can no longer slow page loads. Workers are
   scaled with `WORKER_REPLICAS` in `infra/compose.prod.yaml`. All replicas must share the `files`
   volume, so they run on one host; a second worker host needs object storage first.
2. **Concurrency comes from the hardware**, not a fixed number: `jobs = min(cores - 1, memory /
JOB_MEMORY_MB)` (container memory limit respected), at least 1. `OFFICE_CONCURRENCY` (default
   about half) bounds LibreOffice. Every value can be overridden with an env var.
3. **Two lanes.** PDFs and images use `document.process-upload`; Office files use
   `document.process-office` with its own small pool, so a burst of Word files cannot hold up quick
   jobs.
4. **Admission control for previews.** `POST /print-preview` runs inside the request, so it goes
   through a gate: at most `PREVIEW_CONCURRENCY` at once (cores and memory bound), up to
   `PREVIEW_MAX_WAITING` waiting, and beyond that an immediate `503 busy` with `Retry-After: 3`.
   The web client retries quietly. Latency stays bounded instead of growing for everyone.
5. **Visible waiting.** While a file is processing the upload view carries `queueAhead` (files of
   the same lane queued before it), shown as "N files are ahead of yours".
6. **Realtime across processes.** With separate processes, `@socket.io/postgres-adapter` relays
   events (through LISTEN/NOTIFY) from the worker to the browsers connected to the API. A single
   `all` process needs no adapter.
7. **Storage accounting in SQL.** The per-upload quota check used to read every upload row; it is
   now one aggregate query.

## Why not autoscaling

Autoscaling adds capacity only when there is somewhere to put it. On one server it cannot create
CPU, and Dokploy has no metric-driven scaler: replicas are set by hand. A tuned fixed worker count
plus visible waiting gives the same result with much less machinery. If the load test (phase 9)
shows the busy hours need more, in order: raise the server size, then add a worker host (needs
shared storage), and only then consider scaling rules.

## How to size it (phase 9 load test)

Measure seconds per conversion and uploads per minute at 1, 2, 3, 4 concurrent jobs on the real
server. Throughput rises, flattens, then falls; pick the value at the flat part. Keep
`replicas x WORKER_CONCURRENCY` at or below spare cores, and `replicas x WORKER_CONCURRENCY x
JOB_MEMORY_MB` below the worker memory limit.
