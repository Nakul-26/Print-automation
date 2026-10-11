import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const ApiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  STORAGE_ROOT: z.string().default('./data'),
  /** Default global storage limit (bytes). Overridable at runtime from platform_settings. */
  STORAGE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 ** 3),
  RETENTION_HOURS: z.coerce.number().positive().default(24),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(168),
  /** Max login attempts per IP per 15 minutes. */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  TRUST_PROXY: bool,
});
export type ApiEnv = z.infer<typeof ApiEnvSchema>;

/** The only place in the codebase allowed to read process.env. */
export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = ApiEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}
