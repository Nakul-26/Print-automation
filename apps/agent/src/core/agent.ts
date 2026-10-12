import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import {
  AGENT,
  PrintJobSpec,
  type AgentHello,
  type AgentPrinter,
  type JobStatusUpdate,
} from '@print/contracts';
import type { ConfigStore, SavedConfig } from './config-store.js';
import { downloadJobFile, pairWithServer } from './http.js';
import { JobRunner } from './job-runner.js';
import type { JobLedger } from './ledger.js';
import type { AgentState, Log, PrinterLister, PrintPort } from './types.js';
import { AgentError } from './types.js';

export interface PrintAgentDeps {
  store: ConfigStore;
  ledger: JobLedger;
  lister: PrinterLister;
  printer: PrintPort;
  log: Log;
  version: string;
  /** This PC's name, shown to the owner in the dashboard. */
  deviceName: string;
  /** Used when pairing; a saved pairing keeps its own server. */
  defaultServerUrl: string;
  tempDir: string;
  /** How often the PC's printers are re-read to notice changes. */
  printerPollMs?: number;
  /** How long to wait for the server to acknowledge a message. */
  ackTimeoutMs?: number;
  /** After the server drops the connection on purpose, wait this long before trying again. */
  serverDropRetryMs?: number;
  /** Replaced in tests. */
  connect?: (url: string, token: string) => Socket;
}

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

/**
 * The printing app's brain, independent of any window: it pairs with a shop, keeps the live
 * connection, tells the server which printers exist, and prints what it is sent. The Electron
 * shell and the command-line runner are thin wrappers around this.
 */
export class PrintAgent extends EventEmitter {
  private config: SavedConfig | null = null;
  private socket: Socket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastHello = '';
  private readonly runner: JobRunner;
  private current: AgentState;

  constructor(private readonly deps: PrintAgentDeps) {
    super();
    this.current = {
      phase: 'unpaired',
      version: deps.version,
      shopName: null,
      deviceName: deps.deviceName,
      serverUrl: null,
      printers: [],
      jobs: deps.ledger.recent(),
      notice: null,
    };
    this.runner = new JobRunner({
      ledger: deps.ledger,
      printer: deps.printer,
      lister: deps.lister,
      tempDir: deps.tempDir,
      log: deps.log,
      onChange: () => this.update({ jobs: deps.ledger.recent() }),
      download: (job, dest) =>
        downloadJobFile(this.config!.serverUrl, this.config!.token, job, dest),
      report: (update) => this.report(update),
    });
  }

  get state(): AgentState {
    return this.current;
  }

  /** Resolves when every job received so far has finished (used by tests). */
  idle(): Promise<void> {
    return this.runner.idle();
  }

  private update(patch: Partial<AgentState>): void {
    this.current = { ...this.current, ...patch };
    this.emit('state', this.current);
  }

  /** Connects if this PC is already paired. */
  start(): void {
    const saved = this.deps.store.load();
    if (!saved) {
      this.update({ phase: 'unpaired' });
      return;
    }
    this.config = saved;
    this.update({
      shopName: saved.shopName,
      serverUrl: saved.serverUrl,
      deviceName: saved.deviceName || this.deps.deviceName,
      notice: null,
    });
    this.connect();
  }

  /** Links this PC to a shop with the 6-digit code from the dashboard. */
  async pair(code: string, serverUrl?: string): Promise<void> {
    const url = trimUrl(serverUrl ?? this.deps.defaultServerUrl);
    const cleaned = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) {
      throw new AgentError('The code has six digits. Check the number on the dashboard.');
    }
    const paired = await pairWithServer(url, {
      code: cleaned,
      deviceName: this.deps.deviceName,
      version: this.deps.version,
    });
    const saved: SavedConfig = {
      serverUrl: url,
      deviceId: paired.deviceId,
      token: paired.token,
      shopName: paired.shopName,
      deviceName: this.deps.deviceName,
    };
    this.deps.store.save(saved);
    this.disconnect();
    this.config = saved;
    this.update({ shopName: saved.shopName, serverUrl: url, notice: null });
    this.connect();
  }

  /** Forgets the shop; the dashboard shows the app as gone. */
  unpair(notice: string | null = null): void {
    this.disconnect();
    this.deps.store.clear();
    this.config = null;
    this.update({
      phase: 'unpaired',
      shopName: null,
      serverUrl: null,
      printers: [],
      notice,
    });
  }

  stop(): void {
    this.disconnect();
  }

  // ---------- connection ----------

  private connect(): void {
    const config = this.config;
    if (!config) return;
    this.update({ phase: 'connecting' });

    const socket =
      this.deps.connect?.(config.serverUrl, config.token) ??
      io(`${trimUrl(config.serverUrl)}${AGENT.namespace}`, {
        auth: { token: config.token },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 15_000,
      });
    this.socket = socket;

    socket.on('connect', () => {
      void this.sayHello(true).catch((err) =>
        this.deps.log.warn('hello failed', { err: String(err) }),
      );
    });
    socket.on('disconnect', (reason: string) => {
      if (this.socket !== socket) return;
      this.update({ phase: 'offline' });
      // When the server closes the connection itself, socket.io does not retry on its own.
      if (reason === 'io server disconnect') {
        setTimeout(() => {
          if (this.socket === socket) socket.connect();
        }, this.deps.serverDropRetryMs ?? 3000).unref?.();
      }
    });
    socket.on('connect_error', (err: Error) => {
      if (err.message === 'unauthorized') {
        // The shop removed this PC (or the token is invalid): nothing to reconnect to.
        this.unpair('This PC was removed from the shop. Pair it again with a new code.');
        return;
      }
      this.update({ phase: 'offline' });
    });
    socket.on(AGENT.revoked, () => {
      this.unpair('This PC was removed from the shop. Pair it again with a new code.');
    });
    socket.on(AGENT.jobNew, (payload: unknown) => {
      const job = PrintJobSpec.safeParse(payload);
      if (!job.success) {
        this.deps.log.warn('ignored a malformed job');
        return;
      }
      this.runner.enqueue(job.data);
    });

    this.pollTimer = setInterval(() => {
      void this.sayHello(false).catch(() => undefined);
    }, this.deps.printerPollMs ?? 30_000);
    this.pollTimer.unref?.();
  }

  private disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners();
    socket?.disconnect();
    this.lastHello = '';
  }

  /** Tells the server which printers this PC has. `force` on (re)connect; later only on change. */
  private async sayHello(force: boolean): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected) return;

    let printers: AgentPrinter[] = [];
    try {
      printers = await this.deps.lister.list();
    } catch (err) {
      this.deps.log.warn('could not list printers', { err: String(err) });
      this.update({ notice: 'Could not read the printers on this PC.' });
    }
    const hello: AgentHello = { version: this.deps.version, printers };
    const fingerprint = JSON.stringify(hello);
    if (!force && fingerprint === this.lastHello) return;

    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      socket
        .timeout(this.deps.ackTimeoutMs ?? 15_000)
        .emit(AGENT.hello, hello, (err: Error | null, r?: { ok: boolean; error?: string }) =>
          resolve(err ? { ok: false, error: 'no answer' } : (r ?? { ok: false })),
        );
    });
    if (!reply.ok) {
      this.deps.log.warn('server refused hello', { error: reply.error });
      return;
    }
    this.lastHello = fingerprint;
    this.update({ phase: 'online', printers, notice: null });
    if (force) await this.runner.flushReports();
  }

  private report(update: JobStatusUpdate): Promise<boolean> {
    const socket = this.socket;
    if (!socket?.connected) return Promise.resolve(false);
    return new Promise((resolve) => {
      socket
        .timeout(this.deps.ackTimeoutMs ?? 15_000)
        .emit(AGENT.jobStatus, update, (err: Error | null, r?: { ok: boolean; error?: string }) =>
          // A job the server no longer knows will never be acknowledged: stop re-sending it.
          resolve(!err && (r?.ok === true || r?.error === 'not_found')),
        );
    });
  }
}
