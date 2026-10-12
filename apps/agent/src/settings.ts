/* The only file in the agent that reads the process environment and command line. */

declare const __DEFAULT_SERVER__: string | undefined;
declare const __UPDATE_URL__: string | undefined;

export interface RuntimeSettings {
  /** The platform's address, e.g. https://print.example.com. */
  serverUrl: string;
  /** Where the app keeps its files. Electron's per-user folder when unset. */
  dataDir: string | null;
  /** Keep copies of the PDFs here instead of printing (development and testing). */
  recordDir: string | null;
  /** Use this JSON list of printers instead of asking Windows (development and testing). */
  fakePrintersFile: string | null;
  /** Where our own update files are published (manual installer only). */
  updateUrl: string | null;
}

function flag(argv: string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export function readSettings(
  argv: string[] = process.argv.slice(1),
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettings {
  const baked =
    typeof __DEFAULT_SERVER__ === 'string' && __DEFAULT_SERVER__ ? __DEFAULT_SERVER__ : null;
  const update = typeof __UPDATE_URL__ === 'string' && __UPDATE_URL__ ? __UPDATE_URL__ : null;
  return {
    serverUrl:
      flag(argv, 'server') ?? env['PRINT_AGENT_SERVER'] ?? baked ?? 'http://localhost:4000',
    dataDir: flag(argv, 'data') ?? env['PRINT_AGENT_DATA'] ?? null,
    recordDir: flag(argv, 'record-dir') ?? env['PRINT_AGENT_RECORD_DIR'] ?? null,
    fakePrintersFile: flag(argv, 'fake-printers') ?? env['PRINT_AGENT_FAKE_PRINTERS'] ?? null,
    updateUrl: update,
  };
}

export { flag };
