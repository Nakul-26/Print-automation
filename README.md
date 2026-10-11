# Print Platform

Multi-shop print-order platform. Students upload documents and choose print settings; shop owners see a live queue and click **Print** or **Reject**. See [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) for the full plan and [`docs/adr`](docs/adr) for architecture decisions.

## Requirements

- Node.js 22+ (see `.nvmrc`), pnpm 11, Docker

Ghostscript runs inside the `print-tools` container in development (`GS_COMMAND=docker exec -i print-tools gs` in `apps/api/.env`), so nothing needs installing on Windows. In production images and CI, `gs` is installed directly.

Note: the API defaults to port 4000; set `PORT` if another project already uses it.

## Getting started

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # then set SESSION_SECRET (32+ chars)
pnpm db:up                               # start local PostgreSQL + the Ghostscript tools container
pnpm --filter @print/api prisma migrate dev
pnpm dev                                 # API on :4000, web on :5173
```

## Creating a platform admin and a shop (until the admin panel exists)

```bash
pnpm --filter @print/api cli create-admin --email you@example.com --name "Your Name"
pnpm --filter @print/api cli create-shop --name "Demo Prints" --slug demo-prints \
  --owner-email owner@example.com --owner-name "Shop Owner"
```

Passwords are generated and printed once. Run tests with `pnpm test` (needs `pnpm db:up`; integration tests use a separate `print_test` database).

## Useful commands

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `pnpm check`      | typecheck + lint + module-boundary check + tests          |
| `pnpm boundaries` | verify architecture rules (module imports, domain purity) |
| `pnpm db:up/down` | start/stop the local database                             |
| `pnpm build`      | production build of all apps                              |

## Layout

```
apps/api        Express API (modules/, platform/)
apps/web        React + Vite + Tailwind
packages/       contracts (zod schemas), domain (pure rules), config (env)
infra/          Docker/compose files
docs/           ADRs and runbooks
```

## Production images

Everything ships as containers: `web` (nginx), `api` (Node + Ghostscript + LibreOffice), and `postgres`, defined in `infra/compose.prod.yaml`.

Try the production stack locally:

```bash
cp infra/.env.production.example infra/.env.local   # then edit the values
docker compose --env-file infra/.env.local -f infra/compose.prod.yaml -f infra/compose.prod.local.yaml up --build
# open http://localhost:8080
```

Deploying with Dokploy: create a Compose application from this repository, set the compose path to `infra/compose.prod.yaml`, enter the variables from `infra/.env.production.example` in the Environment tab, and attach your domain to the `web` service on port 80. See `docs/adr/0005-office-conversion-and-containers.md`.

Note: if port 4000 is taken, run the API with `PORT=4100` and the web app with `API_PROXY_TARGET=http://localhost:4100 pnpm --filter @print/web dev`. Open a shop at `http://localhost:5173/s/<slug>`.
