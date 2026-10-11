import { spawn } from 'node:child_process';
import { ProcessingError } from './errors.js';

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
export function runGhostscript(
  options: GhostscriptOptions,
  extraArgs: string[],
  input: Buffer,
): Promise<GhostscriptResult> {
  const [bin, ...prefix] = options.command.trim().split(/\s+/);
  if (!bin)
    return Promise.reject(
      new ProcessingError('tool_unavailable', 'Printing tools are unavailable'),
    );
  const maxOutput = options.maxOutputBytes ?? 300 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefix, ...BASE_ARGS, ...extraArgs, '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out: Buffer[] = [];
    let outSize = 0;
    let log = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(new ProcessingError('timeout', 'This document took too long to process')),
      );
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > maxOutput) {
        child.kill('SIGKILL');
        finish(() =>
          reject(new ProcessingError('corrupt_file', 'This document is too large to process')),
        );
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (log.length < 8_000) log += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new ProcessingError(
            err.code === 'ENOENT' ? 'tool_unavailable' : 'processing_failed',
            'Document processing is temporarily unavailable',
            { cause: err },
          ),
        ),
      );
    });

    child.on('close', (code) => {
      finish(() => {
        // Ghostscript exits 0 even when it could not open the input, writing an empty
        // document instead, so failures have to be recognised from its log.
        const unreadable =
          /No pages will be processed|Couldn't initialise file|Unrecoverable error/i;
        if (code === 0 && !/requires a password/i.test(log) && !unreadable.test(log)) {
          resolve({ output: Buffer.concat(out), log });
        } else if (/password/i.test(log)) {
          reject(
            new ProcessingError(
              'encrypted_pdf',
              'This PDF is password-protected. Remove the password and upload it again.',
            ),
          );
        } else {
          reject(
            new ProcessingError(
              'corrupt_file',
              'This file could not be read. It may be damaged; try exporting it again.',
              { cause: new Error(log.slice(0, 500)) },
            ),
          );
        }
      });
    });

    child.stdin.on('error', () => {
      /* the process may exit before reading everything; the close handler reports it */
    });
    child.stdin.end(input);
  });
}

export const GRAYSCALE_ARGS = ['-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray'];
export const PREPRESS_ARGS = ['-dPDFSETTINGS=/prepress'];
