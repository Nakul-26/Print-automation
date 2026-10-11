import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/test-env.js';

/** Tool commands come from the environment, then apps/api/.env (docker exec ...), then a default. */
function resolveEnv(name: string, fallback: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  if (existsSync('.env')) {
    const prefix = `${name}=`;
    const line = readFileSync('.env', 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(prefix));
    if (line) return line.slice(prefix.length).trim();
  }
  return fallback;
}

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      GS_COMMAND: resolveEnv('GS_COMMAND', 'gs'),
      OFFICE_COMMAND: resolveEnv('OFFICE_COMMAND', 'python3 /opt/print-convert/convert.py'),
    },
    // Integration tests share one database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
