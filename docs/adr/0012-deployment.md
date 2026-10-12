# 0012. Deployment, backups and recovery

Status: accepted

## Shape

One Dokploy Compose application per environment (production, staging) from the same
`infra/compose.prod.yaml`: `postgres`, `api`, `worker`, `web` (nginx), `backup`. The server sits behind
a Cloudflare Tunnel: nothing inbound, HTTPS at Cloudflare, Dokploy's proxy routes by host name.
Staging is a second application with its own volumes, secrets and domain, on the same PC.

## Decisions

- **Database role.** The application connects as `print_app`, created on first start by
  `infra/postgres/init-app-role.sh`: not a superuser, cannot create roles or databases, owns only the
  `print` database. It is not limited to DML because Prisma migrations and pg-boss manage their own
  tables. Verified: `CREATE ROLE`, `COPY … PROGRAM`, and connecting to other databases are refused.
  The superuser password lives only on `postgres` and `backup`.
- **Backups.** A sidecar (`infra/backup`) does a nightly `pg_dump`, restores it into a scratch
  database and compares migration and table counts, encrypts with **age** using a public key (the
  server cannot read its own backups), uploads to Cloudflare R2 with rclone, checks the uploaded size,
  and prunes after 30 days. Failure → unhealthy container + optional monitor ping. A restore of the
  encrypted file with the private key was done end to end (`restore.sh`, drill in `runbook.md`).
  Uploaded documents are deliberately not backed up (kept one day by design).
- **Never back up an empty database.** Found in the disaster drill: a rebuilt empty database would
  have uploaded an empty "latest" backup a minute after start. The job skips while there are no users.
- **Real client IP.** Behind tunnel + proxy every request arrives from an internal address, so the
  per-visitor rate limits would have counted all students as one. nginx takes `CF-Connecting-IP` only
  from private networks and passes a single `X-Forwarded-For`.
- **nginx re-resolves `api` every 5 s.** Found in the crash test: after the API container restarted
  alone, nginx kept its old address (a 502, later another container's page). Verified fixed: API-only
  restart recovers in about 4 s, a hard-killed database in about 9 s with no manual step.
- **Log size capped** (3 × 10 MB per container) so logs cannot fill the disk.
- **Compose passes unset optional variables as empty strings**; `loadApiEnv` now treats empty as unset.

## Not done / later

- Recovery point is up to 24 h. More frequent dumps or WAL archiving (point-in-time recovery) only if
  the pilot shows that matters.
- Single host: the database, files and workers share one PC and one disk. No high availability.
- No automatic off-site copy of the Dokploy configuration; the environment text is kept by the owner.
