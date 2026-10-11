# ADR 0003: Authentication, sessions, and tenant isolation

Status: accepted (2026-10-11)

## Authentication

- Passwords: argon2id (`@node-rs/argon2`, library defaults); minimum 10 characters.
- Sessions are server-side rows. The browser holds an opaque random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). The database stores only an HMAC-SHA256 of the token (keyed with `SESSION_SECRET`), so a database leak cannot be replayed as cookies.
- Sessions last `SESSION_TTL_HOURS` (default 7 days), slide at most once an hour, and stop working immediately when the user is disabled or logs out.
- Login failures return one generic message and take the same time for unknown emails (dummy hash check). Login is rate-limited per IP (`LOGIN_RATE_LIMIT_MAX` per 15 minutes).
- CSRF: `SameSite=Lax` plus an Origin check on state-changing requests.

## Tenant isolation

- Roles: platform role (`user` / `platform_admin`) on the user; shop role (`owner` / `staff`) on `shop_members`.
- Every shop-scoped route is mounted under `/…/:shopId/…` and passes through `requireShopAccess`, which checks membership in the database on every request and sets `req.tenant`. A platform admin is **not** implicitly a member; admin work uses separate `/admin` routes.
- Non-members receive `404`, identical to a non-existent shop, so shop IDs cannot be probed. Suspended shops return `403` to their own members.
- Repositories for shop-owned tables must take a `TenantContext` and scope every query by `shopId`.
- `apps/api/test/tenant-isolation.int.test.ts` is the isolation suite. Every phase that adds a shop-owned resource must add its cross-shop cases there. (The suite was verified to fail when the membership check is deliberately broken.)

## Provisioning

Shops and owners are created with the CLI (`pnpm --filter @print/api cli ...`) until the admin panel and approval flow arrive in phase 8.
