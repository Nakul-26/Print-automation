import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT,
  type AgentHello,
  type AgentPrinter,
  type JobStatusUpdate,
  type PrintJobSpec,
} from '@print/contracts';
import { PrintAgent } from '../src/core/agent.js';
import { FileConfigStore } from '../src/core/config-store.js';
import { JobLedger } from '../src/core/ledger.js';
import { RecordingPrinter } from '../src/core/print-ports.js';
import type { PrinterLister, PrintPort } from '../src/core/types.js';
import { silentLog } from '../src/core/types.js';

const PRINTERS: AgentPrinter[] = [
  { name: 'HP LaserJet', isColor: false, supportsDuplex: true, isDefault: true, offline: false },
  { name: 'Epson L3250', isColor: true, supportsDuplex: true, isDefault: false, offline: false },
];
const DEVICE_TOKEN = 'device-token-123';
const PDF = Buffer.from('%PDF-1.4\n% pretend document\n');

/** A stand-in for the platform: the same HTTP routes and socket events, with no database. */
class FakeServer {
  http: HttpServer;
  io: Server;
  url = '';
  hellos: AgentHello[] = [];
  statuses: JobStatusUpdate[] = [];
  validCode = '123456';
  failDownloadFor = new Set<string>();
  /** Statuses for which the acknowledgement is withheld (simulates a lost connection). */
  muteStatuses = false;

  constructor() {
    this.http = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        if (req.method === 'POST' && req.url === '/api/v1/agent/pair') {
          if (body.code !== this.validCode) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: { message: 'That code is not valid or has expired.' } }),
            );
            return;
          }
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              deviceId: '22222222-2222-4222-8222-222222222222',
              token: DEVICE_TOKEN,
              shopName: 'Alpha Prints',
            }),
          );
          return;
        }
        const file = /^\/api\/v1\/agent\/jobs\/([^/]+)\/file$/.exec(req.url ?? '');
        if (file && req.headers.authorization === `Bearer ${DEVICE_TOKEN}`) {
          if (this.failDownloadFor.has(file[1]!)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          res.end(PDF);
          return;
        }
        res.writeHead(401).end();
      });
    });
    this.io = new Server(this.http);
    const agents = this.io.of(AGENT.namespace);
    agents.use((socket, next) =>
      (socket.handshake.auth as { token?: string }).token === DEVICE_TOKEN
        ? next()
        : next(new Error('unauthorized')),
    );
    agents.on('connection', (socket) => {
      socket.on(AGENT.hello, (hello: AgentHello, ack: (r: unknown) => void) => {
        this.hellos.push(hello);
        ack({ ok: true, shopName: 'Alpha Prints' });
      });
      socket.on(AGENT.jobStatus, (update: JobStatusUpdate, ack: (r: unknown) => void) => {
        this.statuses.push(update);
        if (!this.muteStatuses) ack({ ok: true });
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }

  send(job: PrintJobSpec): void {
    this.io.of(AGENT.namespace).emit(AGENT.jobNew, job);
  }

  async close(): Promise<void> {
    await this.io.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const job = (id: string, over: Partial<PrintJobSpec> = {}): PrintJobSpec => ({
  id,
  kind: 'order',
  label: `P001 · ${id.slice(0, 4)}.pdf`,
  printerName: 'HP LaserJet',
  color: false,
  duplex: 'none',
  copies: 1,
  paperSize: 'A4',
  filePath: `/api/v1/agent/jobs/${id}/file`,
  fileBytes: PDF.length,
  ...over,
});
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let server: FakeServer;
let dir: string;
let printers: AgentPrinter[];
const agents: PrintAgent[] = [];

const lister: PrinterLister = { list: async () => printers };

function makeAgent(printer?: PrintPort): PrintAgent {
  const agent = new PrintAgent({
    store: new FileConfigStore(join(dir, 'config.json')),
    ledger: new JobLedger(join(dir, 'jobs.json')),
    lister,
    printer: printer ?? new RecordingPrinter(join(dir, 'out')),
    log: silentLog,
    version: '9.9.9',
    deviceName: 'COUNTER-PC',
    defaultServerUrl: server.url,
    tempDir: join(dir, 'tmp'),
    printerPollMs: 100,
    ackTimeoutMs: 400,
    serverDropRetryMs: 100,
  });
  agents.push(agent);
  return agent;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-e2e-'));
  printers = structuredClone(PRINTERS);
  server = new FakeServer();
  await server.listen();
});
afterEach(async () => {
  agents.splice(0).forEach((a) => a.stop());
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('linking this PC', () => {
  it('trades the code for a token, connects, and tells the server about its printers', async () => {
    const agent = makeAgent();
    agent.start();
    expect(agent.state.phase).toBe('unpaired');

    await agent.pair('123 456');
    await until(() => agent.state.phase === 'online', 'to be online');
    expect(agent.state.shopName).toBe('Alpha Prints');
    expect(server.hellos[0]).toMatchObject({ version: '9.9.9' });
    expect(server.hellos[0]!.printers.map((p) => p.name)).toEqual(['HP LaserJet', 'Epson L3250']);
    expect(agent.state.printers).toHaveLength(2);
  });

  it('explains a wrong code in plain words and stays unpaired', async () => {
    const agent = makeAgent();
    agent.start();
    await expect(agent.pair('999999')).rejects.toThrow('not valid or has expired');
    await expect(agent.pair('12')).rejects.toThrow('six digits');
    expect(agent.state.phase).toBe('unpaired');
  });

  it('stays linked after a restart, with no code needed', async () => {
    const first = makeAgent();
    first.start();
    await first.pair('123456');
    first.stop();

    const second = makeAgent();
    second.start();
    await until(() => second.state.phase === 'online', 'the restarted app to reconnect');
    expect(second.state.shopName).toBe('Alpha Prints');
  });

  it('forgets the shop when the server says this PC was removed', async () => {
    const agent = makeAgent();
    agent.start();
    await agent.pair('123456');
    await until(() => agent.state.phase === 'online', 'to be online');

    server.io.of(AGENT.namespace).emit(AGENT.revoked, {});
    await until(() => agent.state.phase === 'unpaired', 'to be unlinked');
    expect(agent.state.notice).toMatch(/removed from the shop/);
    expect(new FileConfigStore(join(dir, 'config.json')).load()).toBeNull();
  });

  it('notices a PC whose token no longer works', async () => {
    const store = new FileConfigStore(join(dir, 'config.json'));
    store.save({
      serverUrl: server.url,
      deviceId: 'x',
      token: 'stale-token',
      shopName: 'Old',
      deviceName: 'PC',
    });
    const agent = makeAgent();
    agent.start();
    await until(() => agent.state.phase === 'unpaired', 'the stale token to be rejected');
    expect(agent.state.notice).toMatch(/Pair it again/);
  });
});

describe('printing', () => {
  async function online(printer?: PrintPort): Promise<PrintAgent> {
    const agent = makeAgent(printer);
    agent.start();
    await agent.pair('123456');
    await until(() => agent.state.phase === 'online', 'to be online');
    return agent;
  }

  it('downloads, prints with the exact settings, and reports each step', async () => {
    const agent = await online();
    server.send(job(JOB_A, { printerName: 'Epson L3250', color: true, duplex: 'long', copies: 2 }));
    await until(() => server.statuses.some((s) => s.status === 'done'), 'the job to finish');

    expect(server.statuses.map((s) => s.status)).toEqual(['printing', 'done']);
    const out = join(dir, 'out');
    expect(readFileSync(join(out, `${JOB_A}.pdf`))).toEqual(PDF);
    const note = JSON.parse(readFileSync(join(out, `${JOB_A}.json`), 'utf8'));
    expect(note).toMatchObject({ printerName: 'Epson L3250', copies: 2, duplex: 'long' });
    expect(note.sumatra).toContain('duplexlong,color,2x,paper=A4');
    expect(agent.state.jobs[0]).toMatchObject({ status: 'done' });
    expect(existsSync(join(dir, 'tmp')) && readdirSync(join(dir, 'tmp')).length).toBe(0);
  });

  it('prints jobs one after another, in order', async () => {
    const order: string[] = [];
    const slow: PrintPort = {
      async print(j) {
        order.push(`start ${j.id.slice(0, 1)}`);
        await sleep(80);
        order.push(`end ${j.id.slice(0, 1)}`);
      },
    };
    await online(slow);
    server.send(job(JOB_A));
    server.send(job(JOB_B));
    await until(() => server.statuses.filter((s) => s.status === 'done').length === 2, 'both jobs');
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('never prints the same job twice, however often the server sends it', async () => {
    let prints = 0;
    const counting: PrintPort = { print: async () => void prints++ };
    const agent = await online(counting);
    server.send(job(JOB_A));
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'done'), 'the first print');
    server.send(job(JOB_A));
    await agent.idle();
    await sleep(100);
    expect(prints).toBe(1);
  });

  it('reports a failure in words the owner understands', async () => {
    const broken: PrintPort = {
      print: async () => {
        throw new (await import('../src/core/types.js')).AgentError('Out of paper');
      },
    };
    const agent = await online(broken);
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'failed'), 'the failure report');
    expect(server.statuses.at(-1)).toMatchObject({ status: 'failed', error: 'Out of paper' });
    expect(agent.state.jobs[0]).toMatchObject({ status: 'failed', error: 'Out of paper' });
  });

  it('hides unexpected technical errors behind a plain message', async () => {
    const crashing: PrintPort = {
      print: async () => {
        throw new Error('EPERM: C:\\secret\\path');
      },
    };
    await online(crashing);
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'failed'), 'the failure report');
    expect(server.statuses.at(-1)!.error).toBe('Something went wrong while printing.');
  });

  it('fails early when the printer is gone or switched off', async () => {
    await online();
    printers[0] = { ...printers[0]!, offline: true };
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'failed'), 'the offline report');
    expect(server.statuses.at(-1)!.error).toMatch(/offline/);

    server.send(job(JOB_B, { printerName: 'Brother HL' }));
    await until(() => server.statuses.filter((s) => s.status === 'failed').length === 2, 'second');
    expect(server.statuses.at(-1)!.error).toMatch(/not found on this PC/);
  });

  it('says so when the file has expired on the server', async () => {
    await online();
    server.failDownloadFor.add(JOB_A);
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'failed'), 'the failure report');
    expect(server.statuses.at(-1)!.error).toMatch(/no longer available/);
  });

  it('keeps an outcome it could not deliver and sends it after reconnecting', async () => {
    const agent = await online();
    server.muteStatuses = true; // the server hears the report but the acknowledgement is lost
    server.send(job(JOB_A));
    await until(() => server.statuses.some((s) => s.status === 'done'), 'the print');
    await agent.idle();
    expect(new JobLedger(join(dir, 'jobs.json')).unreported().map((u) => u.id)).toEqual([JOB_A]);

    server.muteStatuses = false;
    server.io.of(AGENT.namespace).disconnectSockets(true); // the connection drops; the app reconnects
    await until(
      () => new JobLedger(join(dir, 'jobs.json')).unreported().length === 0,
      'the outcome to be delivered',
    );
    expect(server.statuses.filter((s) => s.status === 'done').length).toBeGreaterThanOrEqual(2);
  });

  it('after a crash mid-print, fails the job instead of printing it a second time', async () => {
    // The previous run died while printing JOB_A.
    new JobLedger(join(dir, 'jobs.json')).set(JOB_A, {
      label: 'P001 · aaaa.pdf',
      status: 'printing',
      error: null,
      at: new Date().toISOString(),
      reported: false,
    });
    let prints = 0;
    await online({ print: async () => void prints++ });
    server.send(job(JOB_A));
    await until(
      () => server.statuses.some((s) => s.status === 'failed'),
      'the interruption report',
    );
    expect(prints).toBe(0);
    expect(server.statuses.at(-1)!.error).toMatch(/restarted while printing/);
  });
});

describe('printer changes', () => {
  it('tells the server when a printer is added, without being asked', async () => {
    const agent = makeAgent();
    agent.start();
    await agent.pair('123456');
    await until(() => server.hellos.length >= 1, 'the first hello');

    printers.push({
      name: 'Brother HL',
      isColor: false,
      supportsDuplex: false,
      isDefault: false,
      offline: false,
    });
    await until(() => server.hellos.some((h) => h.printers.length === 3), 'the updated list');
    expect(agent.state.printers).toHaveLength(3);
  });
});
