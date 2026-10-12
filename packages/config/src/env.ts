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
  /** Above this share of STORAGE_MAX_BYTES the oldest files are removed... */
  STORAGE_HIGH_WATERMARK: z.coerce.number().gt(0).lte(1).default(0.9),
  /** ...until usage is back under this share. */
  STORAGE_LOW_WATERMARK: z.coerce.number().gt(0).lt(1).default(0.75),
  /** How often expired files are deleted and storage is checked (cron, UTC). */
  RETENTION_SWEEP_CRON: z.string().min(1).default('*/2 * * * *'),
  /** Orders still "processing" after this long are marked failed. */
  STUCK_PROCESSING_MINUTES: z.coerce.number().positive().default(15),
  /** Requests per IP per 15 minutes across the whole API, on top of the per-endpoint limits. */
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(6000),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(20 * 1024 * 1024),
  /** Command that runs Ghostscript (stdin -> stdout). Dev on Windows: 'docker exec -i print-tools gs'. */
  GS_COMMAND: z.string().min(1).default('gs'),
  /** Runs infra/office/convert.py (LibreOffice). Dev on Windows: 'docker exec -i print-tools python3 /opt/print-convert/convert.py'. */
  OFFICE_COMMAND: z.string().min(1).default('python3 /opt/print-convert/convert.py'),
  OFFICE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(500),
  /** Max setting changes (re-conversions) per IP per 15 minutes. */
  CONVERT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  /** Max uploads per IP per 15 minutes. */
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  /** Cloudflare Turnstile keys. Leave unset to disable bot checks (development). */
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  /** Max orders per IP per 15 minutes. */
  ORDER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  /** Max price estimates per IP per 15 minutes. */
  ESTIMATE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /** Most copies of one document in an order. */
  MAX_COPIES: z.coerce.number().int().positive().max(500).default(200),
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
  if (parsed.data.STORAGE_LOW_WATERMARK >= parsed.data.STORAGE_HIGH_WATERMARK) {
    throw new Error(
      'Invalid environment configuration:\n  - STORAGE_LOW_WATERMARK: must be lower than STORAGE_HIGH_WATERMARK',
    );
  }
  return parsed.data;
}
