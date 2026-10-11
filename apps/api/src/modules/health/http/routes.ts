import { Router } from 'express';
import type { HealthResponse, ReadyResponse } from '@print/contracts';

/** A named dependency probe; resolves if healthy, rejects otherwise. */
export interface ReadinessCheck {
  name: string;
  run(): Promise<unknown>;
}

export function createHealthRouter(checks: ReadinessCheck[]): Router {
  const router = Router();

  // Liveness: the process is up. Never touches dependencies.
  router.get('/health', (_req, res) => {
    const body: HealthResponse = { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });

  // Readiness: dependencies are reachable.
  router.get('/ready', async (_req, res) => {
    const results: ReadyResponse['checks'] = {};
    await Promise.all(
      checks.map(async (check) => {
        try {
          await check.run();
          results[check.name] = 'ok';
        } catch {
          results[check.name] = 'fail';
        }
      }),
    );
    const ready = Object.values(results).every((r) => r === 'ok');
    const body: ReadyResponse = { status: ready ? 'ready' : 'degraded', checks: results };
    res.status(ready ? 200 : 503).json(body);
  });

  return router;
}
