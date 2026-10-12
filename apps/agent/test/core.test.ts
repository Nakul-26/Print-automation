import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrintJobSpec } from '@print/contracts';
import { FileConfigStore, type SecretBox } from '../src/core/config-store.js';
import { JobLedger } from '../src/core/ledger.js';
import { parseWindowsPrinters } from '../src/core/printers.js';
import { buildPrintSettings, sumatraArgs } from '../src/core/print-ports.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const job = (over: Partial<PrintJobSpec> = {}): PrintJobSpec => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'order',
  label: 'P001 · notes.pdf',
  printerName: 'HP LaserJet',
  color: false,
  duplex: 'none',
  copies: 1,
  paperSize: 'A4',
  filePath: '/api/v1/agent/jobs/x/file',
  fileBytes: null,
  ...over,
});

describe('SumatraPDF settings', () => {
  it('states every setting, so printer defaults never decide', () => {
    expect(buildPrintSettings(job())).toBe('simplex,monochrome,1x,paper=A4');
    expect(buildPrintSettings(job({ color: true, duplex: 'long', copies: 3 }))).toBe(
      'duplexlong,color,3x,paper=A4',
    );
    expect(buildPrintSettings(job({ duplex: 'short', paperSize: 'A3' }))).toBe(
      'duplexshort,monochrome,1x,paper=A3',
    );
  });

  it('prints silently to the named printer, with the file last', () => {
    const args = sumatraArgs(job({ printerName: 'Epson L3250 Series' }), 'C:\\tmp\\a.pdf');
    expect(args.slice(0, 2)).toEqual(['-print-to', 'Epson L3250 Series']);
    expect(args).toContain('-silent');
    expect(args.at(-1)).toBe('C:\\tmp\\a.pdf');
  });
});

describe('reading the PC’s printers', () => {
  it('detects colour and two-sided from the driver’s capabilities', () => {
    const json = JSON.stringify([
      { Name: 'Epson L3250', Default: true, WorkOffline: false, Capabilities: [2, 4, 3] },
      { Name: 'HP LaserJet', Default: false, WorkOffline: true, Capabilities: [4, 5, 13] },
      { Name: 'Old Printer', Default: false, WorkOffline: false, Capabilities: null },
    ]);
    expect(parseWindowsPrinters(json)).toEqual([
      { name: 'Epson L3250', isColor: true, supportsDuplex: true, isDefault: true, offline: false },
      {
        name: 'HP LaserJet',
        isColor: false,
        supportsDuplex: true,
        isDefault: false,
        offline: true,
      },
      {
        name: 'Old Printer',
        isColor: null,
        supportsDuplex: null,
        isDefault: false,
        offline: false,
      },
    ]);
  });

  it('copes with a single printer (PowerShell prints an object, not a list) and with none', () => {
    expect(
      parseWindowsPrinters('{"Name":"Only","Default":true,"WorkOffline":false,"Capabilities":[2]}'),
    ).toHaveLength(1);
    expect(parseWindowsPrinters('')).toEqual([]);
    expect(parseWindowsPrinters('[]')).toEqual([]);
  });

  it('skips entries without a usable name', () => {
    expect(parseWindowsPrinters('[{"Name":null},{"Name":""},{"Name":"Ok"}]')).toHaveLength(1);
  });
});

describe('device token storage', () => {
  const box: SecretBox = {
    encrypt: (s) => `locked:${Buffer.from(s).toString('base64')}`,
    decrypt: (s) => Buffer.from(s.replace('locked:', ''), 'base64').toString(),
  };
  const config = {
    serverUrl: 'https://print.example.com',
    deviceId: 'dev',
    token: 'secret-token',
    shopName: 'Alpha Prints',
    deviceName: 'COUNTER-PC',
  };

  it('never writes the token in clear text and reads it back', () => {
    const file = join(tempDir(), 'config.json');
    const store = new FileConfigStore(file, box);
    store.save(config);
    expect(readFileSync(file, 'utf8')).not.toContain('secret-token');
    expect(store.load()).toEqual(config);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('starts unpaired if the file is damaged or cannot be decrypted', () => {
    const file = join(tempDir(), 'config.json');
    writeFileSync(file, '{not json');
    expect(new FileConfigStore(file, box).load()).toBeNull();
    writeFileSync(file, JSON.stringify({ ...config, token: 'x' }));
    const failing: SecretBox = {
      encrypt: (s) => s,
      decrypt: () => {
        throw new Error('different Windows user');
      },
    };
    expect(new FileConfigStore(file, failing).load()).toBeNull();
  });
});

describe('job ledger', () => {
  it('survives a restart and lists what the server has not heard yet', () => {
    const file = join(tempDir(), 'jobs.json');
    const now = new Date().toISOString();
    const first = new JobLedger(file);
    first.set('a', { label: 'A', status: 'done', error: null, at: now, reported: false });
    first.set('b', {
      label: 'B',
      status: 'failed',
      error: 'Out of paper',
      at: now,
      reported: true,
    });
    first.set('c', { label: 'C', status: 'printing', error: null, at: now, reported: false });

    const second = new JobLedger(file);
    expect(second.get('a')?.status).toBe('done');
    // A job that was mid-print is not "unreported": it is handled as interrupted on resend.
    expect(second.unreported().map((u) => u.id)).toEqual(['a']);
    second.markReported('a');
    expect(second.unreported()).toEqual([]);
  });

  it('forgets old entries', () => {
    const ledger = new JobLedger(null);
    const old = new Date(Date.now() - 10 * 24 * 3_600_000).toISOString();
    ledger.set('old', { label: 'Old', status: 'done', error: null, at: old, reported: true });
    ledger.set('new', {
      label: 'New',
      status: 'done',
      error: null,
      at: new Date().toISOString(),
      reported: true,
    });
    expect(ledger.get('old')).toBeUndefined();
    expect(ledger.recent().map((j) => j.id)).toEqual(['new']);
  });
});
