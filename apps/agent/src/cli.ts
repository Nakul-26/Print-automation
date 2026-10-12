/**
 * Headless runner: the same printing logic as the app, without a window. Used for development
 * and automated checks, and as the base for a Linux/CUPS build later.
 *
 *   tsx src/cli.ts --server=http://localhost:4100 --pair=123456 \
 *     --data=./.agent-data --record-dir=./.agent-out --fake-printers=./printers.json
 */
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrintAgent } from './core/agent.js';
import { FileConfigStore } from './core/config-store.js';
import { JobLedger } from './core/ledger.js';
import { FilePrinterLister, WindowsPrinterLister } from './core/printers.js';
import { RecordingPrinter, SumatraPrinter } from './core/print-ports.js';
import { flag, readSettings } from './settings.js';
import { AgentError, type Log } from './core/types.js';

const VERSION = '0.1.0';

const log: Log = {
  info: (m, x) => console.log(`[agent] ${m}`, x ?? ''),
  warn: (m, x) => console.warn(`[agent] ${m}`, x ?? ''),
  error: (m, x) => console.error(`[agent] ${m}`, x ?? ''),
};

async function main(): Promise<void> {
  const settings = readSettings();
  const dataDir = settings.dataDir ?? join(tmpdir(), 'print-agent');
  const agent = new PrintAgent({
    store: new FileConfigStore(join(dataDir, 'config.json')),
    ledger: new JobLedger(join(dataDir, 'jobs.json')),
    lister: settings.fakePrintersFile
      ? new FilePrinterLister(settings.fakePrintersFile)
      : new WindowsPrinterLister(),
    printer: settings.recordDir
      ? new RecordingPrinter(settings.recordDir)
      : new SumatraPrinter(flag(process.argv, 'sumatra') ?? 'SumatraPDF.exe'),
    log,
    version: VERSION,
    deviceName: flag(process.argv, 'name') ?? hostname(),
    defaultServerUrl: settings.serverUrl,
    tempDir: join(dataDir, 'tmp'),
  });
  agent.on('state', (s) =>
    log.info(`${s.phase}`, { shop: s.shopName, printers: s.printers.length }),
  );

  agent.start();
  const code = flag(process.argv, 'pair');
  if (code) {
    try {
      await agent.pair(code, settings.serverUrl);
    } catch (err) {
      console.error(err instanceof AgentError ? err.message : err);
      process.exit(1);
    }
  }
  process.on('SIGINT', () => {
    agent.stop();
    process.exit(0);
  });
}

void main();
