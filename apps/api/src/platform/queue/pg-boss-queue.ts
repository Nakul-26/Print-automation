import { PgBoss } from 'pg-boss';
import type { Logger } from '../observability/logger.js';
import type { JobQueue } from './job-queue.js';

interface Registration {
  name: string;
  handler: (data: object) => Promise<void>;
  concurrency: number;
  timeoutSeconds: number;
  retryLimit: number;
}

/** JobQueue backed by pg-boss, which keeps jobs in its own schema in PostgreSQL. */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly registrations: Registration[] = [];
  private started = false;

  constructor(
    connectionString: string,
    private readonly logger: Logger,
  ) {
    this.boss = new PgBoss({ connectionString, schema: 'pgboss' });
    this.boss.on('error', (err) => this.logger.error({ err }, 'job queue error'));
  }

  register<T extends object>(
    name: string,
    handler: (data: T) => Promise<void>,
    options: { concurrency?: number; timeoutSeconds?: number; retryLimit?: number } = {},
  ): void {
    this.registrations.push({
      name,
      handler: handler as (data: object) => Promise<void>,
      concurrency: options.concurrency ?? 1,
      timeoutSeconds: options.timeoutSeconds ?? 300,
      retryLimit: options.retryLimit ?? 2,
    });
  }

  async enqueue<T extends object>(name: string, data: T): Promise<void> {
    await this.boss.send(name, data);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const reg of this.registrations) {
      await this.boss.createQueue(reg.name, {
        retryLimit: reg.retryLimit,
        retryDelay: 5,
        retryBackoff: true,
        expireInSeconds: reg.timeoutSeconds,
      });
      await this.boss.work<object>(
        reg.name,
        { localConcurrency: reg.concurrency, pollingIntervalSeconds: 0.5 },
        async (jobs) => {
          for (const job of jobs) await reg.handler(job.data);
        },
      );
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.started = false;
  }
}
