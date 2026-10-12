import type { AgentPrinter, PrintJobSpec } from '@print/contracts';

/** Prints one PDF on one printer with the job's settings. */
export interface PrintPort {
  print(job: PrintJobSpec, filePath: string): Promise<void>;
}

/** Lists the printers installed on this PC. */
export interface PrinterLister {
  list(): Promise<AgentPrinter[]>;
}

export interface Log {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export const silentLog: Log = { info() {}, warn() {}, error() {} };

/** Something went wrong in a way the shop owner can understand and act on. */
export class AgentError extends Error {}

export type Phase = 'unpaired' | 'connecting' | 'online' | 'offline';

export interface JobSummary {
  id: string;
  label: string;
  status: 'printing' | 'done' | 'failed';
  error: string | null;
  at: string;
}

/** Everything the window shows. */
export interface AgentState {
  phase: Phase;
  version: string;
  shopName: string | null;
  deviceName: string | null;
  serverUrl: string | null;
  printers: AgentPrinter[];
  jobs: JobSummary[];
  /** The last thing that went wrong, for the window to show. */
  notice: string | null;
}
