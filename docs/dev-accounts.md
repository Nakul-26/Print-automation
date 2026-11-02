# Dummy accounts for local testing

One account for each kind of person, on your **own PC's** database only.

| Role                    | Email              | Where to sign in | What it sees                                              |
| ----------------------- | ------------------ | ---------------- | --------------------------------------------------------- |
| Platform admin          | `admin@dev.test`   | `/admin`         | every shop, approvals, limits, overview                   |
| Shop owner              | `owner@dev.test`   | `/owner`         | shop "Dev Prints": queue, prices, printers, staff         |
| Shop staff              | `staff@dev.test`   | `/owner`         | the same shop's queue only (no prices, printers or staff) |
| Owner of a pending shop | `pending@dev.test` | `/owner`         | shop "Dev Pending Shop", waiting for approval             |
| Student                 | none               | `/s/dev-prints`  | upload and order, no sign-in                              |

The passwords are in `apps/api/.env.dev-accounts`. That file is git-ignored, so it never leaves your PC.

## Set up

```
pnpm db:up
pnpm --filter @print/api cli seed-dev-accounts
```

- The first time, copy `apps/api/.env.dev-accounts.example` to `apps/api/.env.dev-accounts` and replace
  every `CHANGE-ME…` with a password of at least 10 characters.
- Running the command again is safe: it resets each password to the one in the file and keeps the shops.
- It refuses to run when `NODE_ENV=production` or when the database is not on `localhost`, so it cannot
  create these accounts on a real server.

Never use these emails or passwords on the deployed site. Real accounts there are made with
`create-admin` (platform admin) and the apply page (shops), and owners add their own staff.
