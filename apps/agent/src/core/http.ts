import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PairResponse, type PairRequest, type PrintJobSpec } from '@print/contracts';
import { AgentError } from './types.js';

const trim = (url: string): string => url.replace(/\/+$/, '');

async function messageOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? null;
  } catch {
    return null;
  }
}

/** Trades the 6-digit code from the dashboard for this PC's device token. */
export async function pairWithServer(serverUrl: string, request: PairRequest) {
  let res: Response;
  try {
    res = await fetch(`${trim(serverUrl)}/api/v1/agent/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new AgentError('Could not reach the server. Check the internet connection.');
  }
  if (!res.ok) {
    throw new AgentError(
      (await messageOf(res)) ?? `The server answered with an error (${res.status}).`,
    );
  }
  return PairResponse.parse(await res.json());
}

/** Downloads a job's PDF to `dest`. */
export async function downloadJobFile(
  serverUrl: string,
  token: string,
  job: Pick<PrintJobSpec, 'filePath'>,
  dest: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${trim(serverUrl)}${job.filePath}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AgentError('Could not download the file. Check the internet connection.');
  }
  if (res.status === 404) {
    throw new AgentError('The file is no longer available (the order may have expired).');
  }
  if (!res.ok || !res.body) throw new AgentError(`Could not download the file (${res.status}).`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}
