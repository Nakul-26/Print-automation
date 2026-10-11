import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './test/test-env.js';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: { DATABASE_URL: TEST_DATABASE_URL },
    // Integration tests share one database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
