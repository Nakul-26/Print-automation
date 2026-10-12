# Operations runbook

## What is backed up, and what is not

| Data                                                                                  | Backed up?                               | Why                                                                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL (shops, users, prices, orders, print jobs, settings, audit log, job queue) | **Yes, nightly 02:30 IST**, kept 30 days | This is everything that cannot be recreated.                                                                                       |
| Uploaded documents and print PDFs                                                     | No                                       | By design they are deleted after a day. After a disaster, students re-upload and orders that were mid-flight are shown as expired. |
| Configuration (environment)                                                           | You                                      | Keep a copy of the Dokploy environment text in your password manager.                                                              |
| The age **private** key                                                               | You                                      | See below. Not on the server.                                                                                                      |

Each night the `backup` container: dumps the database → restores that dump into a scratch database and
checks the table and migration counts match → encrypts it with the public key → uploads it to R2 →
checks the uploaded size → deletes copies older than 30 days. If any step fails nothing is marked as
done, the container becomes `unhealthy`, and (if `BACKUP_PING_URL` is set) you get an email. It
retries once an hour later.

An **empty database is never backed up** (so a rebuilt, empty server cannot overwrite the "latest"
backup). After a rebuild, restore first; backups continue by themselves afterwards.

## Taking a backup right now

```
docker exec <backup container> backup.sh once
```

Do this before any risky change (a deploy that changes the database, a manual fix).

## Restore drill (do it before launch, then every 3 months)

A backup you have never restored is a hope, not a backup. This restores the latest backup into a
**separate** database and leaves production alone. Run on the server:

```
cd <the application's folder in Dokploy>/infra   # or use Dokploy's terminal on the backup service
docker compose run --rm --no-deps \
  -v /path/to/age.key:/run/age.key:ro \
  --entrypoint restore.sh backup latest print_drill
docker compose exec postgres psql -U postgres -d print_drill -c "select count(*) from shops"
docker compose exec postgres psql -U postgres -c "drop database print_drill"
```

Expected: `Restored. Tables: 17, migrations: <n>` and a shop count that matches `/admin`.
(`/path/to/age.key` is the file you keep offline; copy it to the server just for this and delete it
after.) If it does not work, treat that as an incident: fix it the same day.

## Disaster recovery (the server or disk is lost)

Tested on 2026-10-12 with a full wipe and rebuild: all containers and volumes deleted, stack rebuilt
from the repository, database restored from the bucket; the shop and all its records came back.

1. Install Linux, Docker and Dokploy on the (new) machine; reconnect the Cloudflare Tunnel.
2. Recreate the Compose application and paste the saved environment (same `SESSION_SECRET` keeps
   people signed in; a new one just signs everyone out). Use the **same `APP_DB_PASSWORD` and
   `POSTGRES_PASSWORD`** or new ones, either works on a fresh volume.
3. Deploy. Then stop the app containers: `docker compose stop api worker web`.
4. Restore into the live database name:
   ```
   docker compose run --rm --no-deps -v /path/to/age.key:/run/age.key:ro \
     --entrypoint restore.sh backup latest print --replace
   ```
5. `docker compose start api worker web`. Check `/admin` shows the shops. Printing apps reconnect by
   themselves (their tokens are in the restored database).
6. Delete `age.key` from the server.

Recovery point: up to 24 hours of data lost (since the last night's backup). Recovery time: about an
hour, most of it installing. To lose less, run `backup.sh once` more often or change `BACKUP_AT`.

## If the backup alert fires

1. `docker logs <backup container> --tail 50`. Common causes: R2 token revoked/expired
   (`AccessDenied`), bucket name wrong, disk full, database down.
2. Fix, then `backup.sh once`. Do not ignore it for more than a day or two.

## Common incidents

| Symptom                              | Look at / do                                                                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site down (Cloudflare 502/1033)      | Is the tunnel connector running (`cloudflared`)? Is Dokploy's proxy up? `docker ps`.                                                                |
| Site loads, uploads fail with "busy" | Normal under a rush (it retries). If constant: `docker stats` (CPU), `/admin` → Limits (storage full?)                                              |
| "Storage full" for students          | `/admin` → Limits: used vs limit. Raise it, or find a shop with a huge cap. Old files clear nightly/at 90%.                                         |
| One shop can't print                 | Owner dashboard → Printing: is the PC app connected? Restart the app on the shop PC.                                                                |
| Power cut                            | PC and Docker start by themselves (see deployment.md). Check backup + site afterwards.                                                              |
| Suspected abuse of one shop          | `/admin` → Suspend (cuts live connections immediately). Reason is stored in the activity log.                                                       |
| Lost the age private key             | Create a new pair now, update `BACKUP_AGE_PUBLIC_KEY`, redeploy, take a backup. Old backups are unreadable.                                         |
| Rotating a leaked secret             | `SESSION_SECRET` (signs everyone out), DB passwords (change in env **and** `ALTER ROLE print_app PASSWORD '…'`), R2 token (create new, update env). |

## Security notes

- Postgres is not published; the app connects as `print_app`, which owns only the `print` database and
  cannot create roles, read server files or run programs. The superuser password exists only on the
  `postgres` and `backup` services.
- Backups are encrypted before they leave the server; the server holds only the public key.
- Cloudflare terminates HTTPS; the server accepts nothing from the internet directly.
