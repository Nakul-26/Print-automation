import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrintJobSpec } from '@print/contracts';
import { AgentError, type PrintPort } from './types.js';

/**
 * SumatraPDF's print settings, comma separated: sides, colour, copies, paper. Everything is
 * stated explicitly (simplex, colour) so the printer's own defaults can never change the result.
 */
export function buildPrintSettings(job: PrintJobSpec): string {
  const sides = { none: 'simplex', long: 'duplexlong', short: 'duplexshort' }[job.duplex];
  return [
    sides,
    job.color ? 'color' : 'monochrome',
    `${job.copies}x`,
    `paper=${job.paperSize}`,
  ].join(',');
}

export function sumatraArgs(job: PrintJobSpec, filePath: string): string[] {
  return [
    '-print-to',
    job.printerName,
    '-print-settings',
    buildPrintSettings(job),
    '-silent',
    '-exit-when-done',
    filePath,
  ];
}

/** Prints through the SumatraPDF that ships inside the app. */
export class SumatraPrinter implements PrintPort {
  constructor(
    private readonly exePath: string,
    private readonly timeoutMs = 180_000,
  ) {}

  print(job: PrintJobSpec, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.exePath, sumatraArgs(job, filePath), {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(new AgentError('The printer took too long. Check that it is on and has paper.'));
      }, this.timeoutMs);
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new AgentError(
            err.code === 'ENOENT'
              ? 'The printing component is missing. Reinstall the printing app.'
              : `Could not start printing: ${err.message}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new AgentError(`The printer did not accept the document (code ${code}).`));
      });
    });
  }
}

/**
 * Prints nothing: keeps a copy of each PDF and a note of the requested settings in a folder.
 * For development and for testing the whole flow on a PC without the real printers.
 */
export class RecordingPrinter implements PrintPort {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async print(job: PrintJobSpec, filePath: string): Promise<void> {
    copyFileSync(filePath, join(this.dir, `${job.id}.pdf`));
    writeFileSync(
      join(this.dir, `${job.id}.json`),
      JSON.stringify({ ...job, sumatra: sumatraArgs(job, '<file>') }, null, 2),
    );
  }
}
