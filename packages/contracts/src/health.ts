import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ReadyResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
