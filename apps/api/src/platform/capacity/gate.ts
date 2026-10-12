/** Thrown when too many callers are already waiting for a slot. */
export class GateFullError extends Error {
  constructor() {
    super('gate full');
  }
}

/**
 * Admission control for heavy work done inside a request. At most `limit` calls run at once,
 * up to `maxWaiting` more wait their turn in order, and anything beyond that is refused at
 * once. Refusing early keeps latency bounded for everyone instead of letting a burst pile up
 * until every request is slow.
 */
export interface Gate {
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly stats: { running: number; waiting: number };
}

export function createGate(limit: number, maxWaiting: number): Gate {
  let running = 0;
  const waiters: (() => void)[] = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next)
      next(); // the slot passes straight to the next caller
    else running--;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= limit) {
        if (waiters.length >= maxWaiting) throw new GateFullError();
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else {
        running++;
      }
      try {
        return await task();
      } finally {
        release();
      }
    },
    get stats() {
      return { running, waiting: waiters.length };
    },
  };
}
