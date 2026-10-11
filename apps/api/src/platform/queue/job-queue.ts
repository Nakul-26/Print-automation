/**
 * Durable background jobs. Business modules depend on this interface only, so the
 * implementation (pg-boss on PostgreSQL today) can change without touching them.
 */
export interface JobQueue {
  /** Declares a queue and the handler that processes its jobs. Call before `start()`. */
  register<T extends object>(
    name: string,
    handler: (data: T) => Promise<void>,
    options?: { concurrency?: number; timeoutSeconds?: number; retryLimit?: number },
  ): void;
  enqueue<T extends object>(name: string, data: T): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
