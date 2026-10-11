import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Prisma CLI only (migrate, studio). The app reads its config via @print/config.
    url: process.env['DATABASE_URL'] ?? 'postgresql://print:print@localhost:5432/print',
  },
});
