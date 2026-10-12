import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { JobStatusUpdate, PrintJobSpec } from '@print/contracts';
import type { JobLedger } from './ledger.js';
import { AgentError, type Log, type PrinterLister, type PrintPort } from './types.js';

export interface JobRunnerDeps {
  ledger: JobLedger;
  printer: PrintPort;
  lister: PrinterLister;
  /** Fetches the job's PDF to a local path. */
  download(job: PrintJobSpec, dest: string): Promise<void>;
  /** Tells the server how a job is going. Resolves false if it could not be delivered. */
  report(update: JobStatusUpdate): Promise<boolean>;
  tempDir: string;
  log: Log;
  /** Something changed that the window should show. */
  onChange(): void;
  now?: () => Date;
}

/**
 * Prints jobs one at a time, in the order they arrive. Every outcome is written to the ledger
 * first and reported second, so nothing is lost or printed twice if the connection drops or the
 * app restarts in the middle.
 */
export class JobRunner {
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly deps: JobRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    mkdirSync(deps.tempDir, { recursive: true });
  }

  /** Queues a job. A job this PC has seen before is never printed again. */
  enqueue(job: PrintJobSpec): void {
    this.chain = this.chain
      .then(() => this.handle(job))
      .catch((err: unknown) => {
        this.deps.log.error('job handler crashed', { err: String(err) });
      });
  }

  /** Resolves when everything queued so far has finished (used by tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Re-sends outcomes the server has not acknowledged (call after reconnecting). */
  async flushReports(): Promise<void> {
    for (const { id, entry } of this.deps.ledger.unreported()) {
      const delivered = await this.deps.report({
        jobId: id,
        status: entry.status === 'done' ? 'done' : 'failed',
        ...(entry.error ? { error: entry.error } : {}),
      });
      if (delivered) this.deps.ledger.markReported(id);
    }
  }

  private async finish(
    job: PrintJobSpec,
    status: 'done' | 'failed',
    error: string | null,
  ): Promise<void> {
    this.deps.ledger.set(job.id, {
      label: job.label,
      status,
      error,
      at: this.now().toISOString(),
      reported: false,
    });
    this.deps.onChange();
    const delivered = await this.deps.report({
      jobId: job.id,
      status,
      ...(error ? { error } : {}),
    });
    if (delivered) this.deps.ledger.markReported(job.id);
  }

  private async handle(job: PrintJobSpec): Promise<void> {
    const { ledger, log } = this.deps;
    const seen = ledger.get(job.id);
    if (seen) {
      if (seen.status === 'printing') {
        // The app stopped while this was printing. Printing again could waste paper, so ask the
        // owner to look at the printer and press Retry.
        await this.finish(
          job,
          'failed',
          'The printing app restarted while printing this. Check the printer, then press Retry.',
        );
      } else if (!seen.reported) {
        await this.flushReports();
      }
      return;
    }

    ledger.set(job.id, {
      label: job.label,
      status: 'printing',
      error: null,
      at: this.now().toISOString(),
      reported: false,
    });
    this.deps.onChange();
    await this.deps.report({ jobId: job.id, status: 'printing' });

    const file = join(this.deps.tempDir, `${randomUUID()}.pdf`);
    try {
      await this.checkPrinter(job);
      await this.deps.download(job, file);
      await this.deps.printer.print(job, file);
      log.info('printed', { job: job.id, printer: job.printerName });
      await this.finish(job, 'done', null);
    } catch (err) {
      const message =
        err instanceof AgentError ? err.message : 'Something went wrong while printing.';
      if (!(err instanceof AgentError)) log.error('print failed', { err: String(err) });
      await this.finish(job, 'failed', message.slice(0, 300));
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Fails early, with a clear reason, when the printer is gone or switched off. */
  private async checkPrinter(job: PrintJobSpec): Promise<void> {
    let printers;
    try {
      printers = await this.deps.lister.list();
    } catch {
      return; // cannot tell; let the print attempt decide
    }
    const found = printers.find((p) => p.name === job.printerName);
    if (!found) {
      throw new AgentError(
        `The printer "${job.printerName}" was not found on this PC. Choose a printer again in the dashboard.`,
      );
    }
    if (found.offline) {
      throw new AgentError(
        `"${job.printerName}" is offline. Turn it on and check its cable or Wi-Fi, then press Retry.`,
      );
    }
  }
}
