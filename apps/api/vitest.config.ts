import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/test-env.js';

/** GS_COMMAND comes from the environment, then apps/api/.env (docker exec ...), then `gs`. */
function resolveGsCommand(): string {
  if (process.env['GS_COMMAND']) return process.env['GS_COMMAND'];
  if (existsSync('.env')) {
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('GS_COMMAND='));
    if (line) return line.slice('GS_COMMAND='.length).trim();
  }
  return 'gs';
}

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: TEST_DATABASE_URL, GS_COMMAND: resolveGsCommand() },
    // Integration tests share one database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
