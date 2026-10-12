import { readFileSync } from 'node:fs';
import type { JobSummary } from './types.js';
import { writeJsonAtomic } from './config-store.js';

export interface LedgerEntry {
  label: string;
  status: 'printing' | 'done' | 'failed';
  error: string | null;
  at: string;
  /** The server has been told this outcome. */
  reported: boolean;
}

const KEEP_MS = 3 * 24 * 3_600_000;
const MAX_ENTRIES = 300;

/**
 * A local record of every job this PC has handled. It stops a job that the server sends again
 * (after a reconnect) from printing twice, and remembers outcomes the server has not heard yet.
 */
export class JobLedger {
  private entries: Record<string, LedgerEntry> = {};

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        this.entries = JSON.parse(readFileSync(file, 'utf8')) as Record<string, LedgerEntry>;
      } catch {
        this.entries = {};
      }
    }
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries[id];
  }

  set(id: string, entry: LedgerEntry): void {
    this.entries[id] = entry;
    this.prune();
    if (this.file) writeJsonAtomic(this.file, this.entries);
  }

  markReported(id: string): void {
    const entry = this.entries[id];
    if (entry && !entry.reported) this.set(id, { ...entry, reported: true });
  }

  /** Outcomes the server has not acknowledged yet (the PC was offline when they happened). */
  unreported(): { id: string; entry: LedgerEntry }[] {
    return Object.entries(this.entries)
      .filter(([, e]) => !e.reported && e.status !== 'printing')
      .map(([id, entry]) => ({ id, entry }));
  }

  recent(limit = 8): JobSummary[] {
    return Object.entries(this.entries)
      .map(([id, e]) => ({ id, label: e.label, status: e.status, error: e.error, at: e.at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);
  }

  private prune(): void {
    const cutoff = new Date(Date.now() - KEEP_MS).toISOString();
    const ids = Object.keys(this.entries);
    for (const id of ids) if (this.entries[id]!.at < cutoff) delete this.entries[id];
    const rest = Object.entries(this.entries).sort(([, a], [, b]) => (a.at < b.at ? 1 : -1));
    for (const [id] of rest.slice(MAX_ENTRIES)) delete this.entries[id];
  }
}
