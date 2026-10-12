import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadApiEnv', () => {
  it('applies defaults, including the 5 GB storage limit', () => {
    const env = loadApiEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.STORAGE_MAX_BYTES).toBe(5 * 1024 ** 3);
    expect(env.RETENTION_HOURS).toBe(24);
  });
  it('requires the low watermark to be under the high one', () => {
    expect(() =>
      loadApiEnv({ ...valid, STORAGE_LOW_WATERMARK: '0.95', STORAGE_HIGH_WATERMARK: '0.9' }),
    ).toThrow(/WATERMARK/);
    expect(loadApiEnv(valid).STORAGE_HIGH_WATERMARK).toBe(0.9);
  });
  it('treats unset or empty concurrency settings as automatic', () => {
    const auto = loadApiEnv({ ...valid, WORKER_CONCURRENCY: '', OFFICE_CONCURRENCY: '' });
    expect(auto.WORKER_CONCURRENCY).toBeUndefined();
    expect(auto.OFFICE_CONCURRENCY).toBeUndefined();
    expect(auto.APP_ROLE).toBe('all');
    expect(loadApiEnv({ ...valid, WORKER_CONCURRENCY: '3', APP_ROLE: 'worker' })).toMatchObject({
      WORKER_CONCURRENCY: 3,
      APP_ROLE: 'worker',
    });
    expect(() => loadApiEnv({ ...valid, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
  });
  it('treats empty optional settings (as Docker Compose passes them) as not set', () => {
    const env = loadApiEnv({ ...valid, TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' });
    expect(env.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(env.TURNSTILE_SECRET_KEY).toBeUndefined();
  });

  it('fails with a readable message on bad config', () => {
    expect(() => loadApiEnv({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
