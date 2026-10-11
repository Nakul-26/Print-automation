# Print Platform

Multi-shop print-order platform. Students upload documents and choose print settings; shop owners see a live queue and click **Print** or **Reject**. See [`DEVELOPMENT_PLAN.md`](DEVELOPMENT_PLAN.md) for the full plan and [`docs/adr`](docs/adr) for architecture decisions.

## Requirements

- Node.js 22+ (see `.nvmrc`), pnpm 11, Docker

## Getting started

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # then set SESSION_SECRET (32+ chars)
pnpm db:up                               # start local PostgreSQL
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
