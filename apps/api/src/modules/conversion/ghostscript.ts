import { ProcessingError } from './errors.js';
import { runProcess } from './run-process.js';

export interface GhostscriptOptions {
  /** e.g. "gs" or "docker exec -i print-tools gs". Split on whitespace, no shell involved. */
  command: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

const BASE_ARGS = [
  '-q',
  '-dBATCH',
  '-dNOPAUSE',
  '-dSAFER', // no file-system or process access from inside the document
  '-sDEVICE=pdfwrite',
  '-dAutoRotatePages=/None',
  '-sstdout=%stderr', // keep stdout for the PDF only
  '-sOutputFile=-',
];

export interface GhostscriptResult {
  output: Buffer;
  log: string;
}

/**
 * Pipes a PDF through Ghostscript (stdin to stdout) so the same code works with a native
 * binary, a container, or a remote wrapper, and never needs shared temp files.
 */
export async function runGhostscript(
  options: GhostscriptOptions,
  extraArgs: string[],
  input: Buffer,
): Promise<GhostscriptResult> {
  const result = await runProcess({
    command: options.command,
    args: [...BASE_ARGS, ...extraArgs, '-'],
    input,
    timeoutMs: options.timeoutMs,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
  const log = result.stderr;

  // Ghostscript exits 0 even when it could not open the input, writing an empty document
  // instead, so failures have to be recognised from its log.
  const unreadable = /No pages will be processed|Couldn't initialise file|Unrecoverable error/i;
  if (result.code === 0 && !/requires a password/i.test(log) && !unreadable.test(log)) {
    return { output: result.stdout, log };
  }
  if (/password/i.test(log)) {
    throw new ProcessingError(
      'encrypted_pdf',
      'This PDF is password-protected. Remove the password and upload it again.',
    );
  }
  throw new ProcessingError(
    'corrupt_file',
    'This file could not be read. It may be damaged; try exporting it again.',
    { cause: new Error(log.slice(0, 500)) },
  );
}

export const GRAYSCALE_ARGS = ['-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray'];
export const PREPRESS_ARGS = ['-dPDFSETTINGS=/prepress'];
