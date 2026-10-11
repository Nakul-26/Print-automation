import { spawn } from 'node:child_process';
import { ProcessingError } from './errors.js';

export interface RunOptions {
  /** e.g. "gs" or "docker exec -i print-tools gs". Split on whitespace; no shell is involved. */
  command: string;
  args: string[];
  input: Buffer;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs an external tool, feeding `input` to stdin and collecting stdout/stderr.
 * Rejects with a ProcessingError if the tool cannot start, runs too long, or floods output.
 * A non-zero exit is NOT an error here: callers know what each tool's exit codes mean.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const [bin, ...prefix] = options.command.trim().split(/\s+/);
  if (!bin) {
    return Promise.reject(
      new ProcessingError('tool_unavailable', 'Printing tools are unavailable'),
    );
  }
  const maxOutput = options.maxOutputBytes ?? 300 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefix, ...options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out: Buffer[] = [];
    let outSize = 0;
    let stderr = '';
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
      if (stderr.length < 8_000) stderr += chunk.toString('utf8');
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
      finish(() => resolve({ code, stdout: Buffer.concat(out), stderr }));
    });

    child.stdin.on('error', () => {
      /* the process may exit before reading everything; the close handler reports it */
    });
    child.stdin.end(options.input);
  });
}
