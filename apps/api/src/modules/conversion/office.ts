import type { OfficeFamily, OfficeSettings } from '@print/contracts';
import { ProcessingError } from './errors.js';
import { runProcess } from './run-process.js';

export interface OfficeOptions {
  /**
   * Command that runs infra/office/convert.py, e.g. "python3 /opt/print-convert/convert.py"
   * or "docker exec -i print-tools python3 /opt/print-convert/convert.py".
   */
  command: string;
  timeoutMs: number;
}

/**
 * Converts an Office document to PDF using LibreOffice, applying the student's settings.
 * The converter runs a fresh, sandboxed LibreOffice per call (no macros, no link updates).
 */
export async function convertOffice(
  options: OfficeOptions,
  input: { bytes: Buffer; family: OfficeFamily; ext: string; settings: OfficeSettings },
): Promise<Buffer> {
  const settings = Buffer.from(JSON.stringify(input.settings)).toString('base64url');
  // The script enforces its own (slightly shorter) deadline so it can clean up LibreOffice.
  const scriptTimeout = Math.max(10, Math.floor(options.timeoutMs / 1000) - 5);

  const result = await runProcess({
    command: options.command,
    args: [
      '--family',
      input.family,
      '--ext',
      input.ext,
      '--settings',
      settings,
      '--timeout',
      String(scriptTimeout),
    ],
    input: input.bytes,
    timeoutMs: options.timeoutMs,
  });

  if (result.code === 0 && result.stdout.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return result.stdout;
  }
  if (result.code === 2) {
    throw new ProcessingError(
      'corrupt_file',
      'This document could not be opened. It may be damaged or password-protected.',
      { cause: new Error(result.stderr.slice(0, 500)) },
    );
  }
  if (result.code === 3) {
    throw new ProcessingError('timeout', 'This document took too long to convert');
  }
  throw new ProcessingError(
    'processing_failed',
    'This document could not be converted. Try exporting it as a PDF from your own software.',
    { cause: new Error(`exit ${result.code}: ${result.stderr.slice(0, 500)}`) },
  );
}
