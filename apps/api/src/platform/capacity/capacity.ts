import { availableParallelism, totalmem } from 'node:os';

/** Memory one print preview (Ghostscript + pdf-lib) is assumed to need. */
const PREVIEW_MEMORY_MB = 200;
/** Share of memory the previews may use; the rest is for Node itself and the OS. */
const PREVIEW_MEMORY_SHARE = 0.6;

export interface Capacity {
  /** Jobs this process runs at once (page counting, PDF clean-up, Office conversion). */
  jobs: number;
  /** Of those, how many may be LibreOffice conversions (the heaviest kind). */
  office: number;
  /** Print previews built at once. */
  previews: number;
}

export interface CapacityInput {
  cores: number;
  memoryBytes: number;
  jobMemoryMb: number;
  /** Explicit settings win over the calculation. */
  jobs?: number | undefined;
  office?: number | undefined;
  previews?: number | undefined;
}

/**
 * How much work one process should run at once. More concurrent jobs than the machine can
 * serve make every job slower, so the number is bounded by both CPU and memory:
 *
 * - jobs = min(cores - 1, memory / memory per job), at least 1. One core is left for the web
 *   server, the database and the OS.
 * - office conversions get about half of the slots, so a burst of Word files cannot starve the
 *   quick PDF and image jobs.
 * - previews are lighter (no LibreOffice): bounded by cores, and by the memory left after the
 *   web server's own needs (each Ghostscript run takes roughly PREVIEW_MEMORY_MB).
 */
export function planCapacity(input: CapacityInput): Capacity {
  const byCpu = Math.max(1, input.cores - 1);
  const byMemory = Math.max(1, Math.floor(input.memoryBytes / (input.jobMemoryMb * 1024 * 1024)));
  const jobs = input.jobs ?? Math.min(byCpu, byMemory);
  const office = Math.min(jobs, input.office ?? Math.max(1, Math.ceil(jobs / 2)));
  const previewsByMemory = Math.max(
    1,
    Math.floor((input.memoryBytes * PREVIEW_MEMORY_SHARE) / (PREVIEW_MEMORY_MB * 1024 * 1024)),
  );
  const previews = input.previews ?? Math.min(byCpu, previewsByMemory);
  return { jobs, office, previews };
}

/** Memory this process may use: the container limit if there is one, else the machine's. */
export function availableMemoryBytes(): number {
  const limit = process.constrainedMemory();
  // 0 means "no limit"; a huge value means the cgroup is unconstrained.
  return limit > 0 && limit < totalmem() ? limit : totalmem();
}

export function systemCapacity(settings: {
  jobMemoryMb: number;
  jobs?: number | undefined;
  office?: number | undefined;
  previews?: number | undefined;
}): Capacity {
  return planCapacity({
    cores: availableParallelism(),
    memoryBytes: availableMemoryBytes(),
    ...settings,
  });
}
