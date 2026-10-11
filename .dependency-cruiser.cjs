/**
 * Architecture rules, enforced in CI via `pnpm boundaries`.
 * See docs/adr/0002-modular-monolith.md.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'modules-only-via-public-api',
      severity: 'error',
      comment: 'A module may import another module only through its index.ts, never its internals.',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'platform-must-not-depend-on-modules',
      severity: 'error',
      comment: 'Platform adapters are generic; they must not know about feature modules.',
      from: { path: '^apps/api/src/platform/' },
      to: { path: '^apps/api/src/modules/' },
    },
    {
      name: 'packages-must-not-depend-on-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment: 'The domain package contains pure business rules: no I/O and no framework imports.',
      from: { path: '^packages/domain/src/' },
      to: { path: '^node_modules/(express|@prisma|pino|socket\\.io|zod)(/|$)' },
    },
    {
      name: 'web-must-not-import-api',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/(api|agent|worker)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    exclude: { path: '\\.test\\.ts$|/generated/|/dist/' },
  },
};
