# Deploying to your server (Dokploy + Cloudflare Tunnel)

Target: the Linux PC (8 cores, 16 GB, 1 TB) running Dokploy, reached through your existing Cloudflare
Tunnel. Production at `print.fiveorbit.tech`, staging at `print-staging.fiveorbit.tech`
(rename as you like; use them consistently below).

The stack (`infra/compose.prod.yaml`) is five containers: `postgres`, `api`, `worker`, `web`
(nginx), `backup`. Only `web` is reachable from outside. Nothing is exposed except through the tunnel.

## 0. Before you start (once)

1. **Push the repository** to GitHub (it is `Nakul-26/Print-automation`). Dokploy builds from it.
2. **Cloudflare R2 bucket for backups** (free tier is enough: ~10 GB):
   Cloudflare dashboard → R2 → Create bucket `fiveorbit-print-backups` → _Manage R2 API tokens_ →
   create a token with **Object Read & Write limited to that bucket**. Write down the Access Key ID,
   Secret Access Key and the endpoint `https://<account id>.r2.cloudflarestorage.com`.
3. **Backup encryption key pair.** On any machine with Docker:
   ```
   docker run --rm alpine sh -c "apk add -q age && age-keygen"
   ```
   It prints a line `# public key: age1...` and a secret line `AGE-SECRET-KEY-...`.
   - The **public** key goes into the server settings (`BACKUP_AGE_PUBLIC_KEY`).
   - The **secret** key must **not** be on the server. Save it in your password manager **and** print
     it or store it on a USB stick. Without it the backups cannot be opened; with it on the server
     anyone who steals the bucket could read everything.
4. **Turnstile** (bot check, free): Cloudflare → Turnstile → add widget for `print.fiveorbit.tech` and
   `print-staging.fiveorbit.tech`. Note the site key and secret key. (Staging can use the test keys in
   `infra/.env.staging.example` instead.)
5. **Backup monitoring** (optional but recommended): create a free check at healthchecks.io with a
   period of 1 day and grace of 3 hours; copy its ping URL into `BACKUP_PING_URL`. You are emailed if
   no backup succeeds.

## 1. Create the production application in Dokploy

1. Project → _Create service_ → **Compose**. Name it `print-prod`.
2. Provider: GitHub, repository `Print-automation`, branch `main`, compose path
   `./infra/compose.prod.yaml`, compose type _Docker Compose_.
3. **Environment** tab: paste `infra/.env.production.example` and fill every value. Generate the
   passwords and `SESSION_SECRET` with the commands in the file. Do not reuse them for staging.
4. **Domains** tab: add a domain for service `web`, port `80`, host `print.fiveorbit.tech`.
   Because HTTPS ends at Cloudflare, set **HTTPS off / certificate: none** here.
5. Deploy. The first build takes several minutes (LibreOffice is large). Wait until all five
   containers are healthy (`backup` turns healthy after its first backup, about a minute after the
   first user exists; see below).

## 2. Connect the Cloudflare Tunnel

In Cloudflare Zero Trust → Networks → Tunnels → your existing tunnel → _Public hostnames_ → add:

| Subdomain | Domain         | Service                                     |
| --------- | -------------- | ------------------------------------------- |
| `print`   | fiveorbit.tech | `HTTP` · `localhost:80` (Dokploy's Traefik) |

If your other sites reach Dokploy a different way (for example straight to a container port), do it
the same way here. The important parts are: the request must reach Dokploy's proxy with the host
name `print.fiveorbit.tech` so the domain rule in step 1.4 matches, and Cloudflare must keep sending
`CF-Connecting-IP` (it does by default). nginx uses that header so rate limits apply to each visitor
rather than to everybody at once.

Recommended extra: a **Cloudflare Access** policy on `print.fiveorbit.tech/admin*` so the admin page
is behind your email login before it even reaches the app.

## 3. First start

1. Open `https://print.fiveorbit.tech`: the start page loads.
2. Create the first platform admin (on the server, from Dokploy's _Terminal_ for the `api` service,
   or `docker exec`):
   ```
   node dist/cli.js create-admin --email you@fiveorbit.tech --name "Your Name"
   ```
   It prints a password once. Sign in at `/admin` and change nothing else yet.
3. Check a backup was made: `backup` container logs show `done: print-....dump.age`, and the file is in
   the R2 bucket. (Until the first user exists the backup job deliberately skips: an empty database
   is never backed up.)
4. **Do the restore drill now**, before real data exists: `docs/runbook.md` → "Restore drill".

## 4. Staging

Make a second Dokploy Compose application `print-staging` from the same repository and compose file,
with its own environment (`infra/.env.staging.example`), its own domain
`print-staging.fiveorbit.tech`, its own tunnel hostname. It has separate volumes and database, so
nothing you try there can touch production. Deploy changes to staging first, click through, then
deploy production.

## 5. Updating and rolling back

- Deploy = push to `main`, then press **Deploy** on staging, check, then on production. Database
  migrations run automatically when `api` starts and are written to be additive.
- A deploy recreates the containers; students mid-upload see a short "reconnecting" and retry. Do it
  outside the busy hours (the shop knows their rush times).
- **Rollback:** Dokploy keeps the previous deployments; redeploy the last good commit. Migrations are
  forward-only, so if a release changed the database, restore the pre-deploy backup instead
  (take a manual one first: `docker compose exec backup backup.sh once`).

## 6. Day-to-day checks

| What                | Where                                                                           |
| ------------------- | ------------------------------------------------------------------------------- |
| Is it up?           | Cloudflare Health Check or UptimeRobot on `https://print.fiveorbit.tech/health` |
| Containers healthy? | Dokploy → the application → _Monitoring_                                        |
| Backup ran?         | healthchecks.io email; `backup` container health; the R2 bucket                 |
| Disk space          | `docker system df`, `df -h`. Logs are capped at 3 × 10 MB per container         |
| Storage use         | `/admin` → Limits                                                               |

## What the server needs

Docker + Dokploy (already), outbound internet, and nothing inbound (the tunnel dials out). Keep the
OS updated and set the PC to power back on after an outage (BIOS: "restore on AC power loss") and
Docker to start on boot (`systemctl enable docker`), so a power cut recovers without you.
