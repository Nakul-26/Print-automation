import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  AGENT,
  AgentHello,
  JobStatusUpdate,
  PAIRING_TTL_MINUTES,
  type MappedPrinter,
  type OrderPrintState,
  type PairRequest,
  type PairResponse,
  type PairingCode,
  type PrinterMappingBody,
  type PrintingStatus,
  type PrintJobSpec,
} from '@print/contracts';
import {
  autoMapPrinters,
  duplexFor,
  type PrinterChoice,
  type PrinterColorMode,
  type PrinterMapping,
} from '@print/domain';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { Realtime } from '../../../platform/realtime/index.js';
import type { StorageDriver } from '../../../platform/storage/index.js';
import type { Audit } from '../../audit/index.js';
import type { DeviceRecord, JobRecord, JobSpec, PrintingRepo } from '../repo/printing-repo.js';

/** What printing needs to tell the orders module. */
export interface OrdersPort {
  /** Every document of the order has been printed. */
  markPrinted(orderId: string): Promise<void>;
  /** Something about the order's printing changed: refresh the shop's and student's screens. */
  touch(orderId: string): Promise<void>;
}

export interface SubmitOrderInput {
  shopId: string;
  orderId: string;
  /** "P014" */
  orderLabel: string;
  items: {
    itemId: string;
    name: string;
    fileKey: string;
    fileBytes: number | null;
    colorMode: PrinterColorMode;
    sides: 'single' | 'double';
    copies: number;
    paperSize: 'A4' | 'A3';
    landscape: boolean;
  }[];
}

export interface PrintingServiceDeps {
  repo: PrintingRepo;
  storage: StorageDriver;
  realtime: Realtime;
  audit: Audit;
  logger: Logger;
  orders: () => OrdersPort;
  findShopName: (shopId: string) => Promise<string | null>;
  tokenSecret: string;
  /** A job the agent took but never finished is failed after this long. */
  staleJobMinutes: number;
  now?: () => Date;
}

const MODE_LABEL: Record<PrinterColorMode, string> = {
  black_white: 'black-and-white',
  color: 'colour',
};
const MAX_FAILED_PAIRINGS_PER_HOUR = 200;

export function createPrintingService(deps: PrintingServiceDeps) {
  const { repo, storage, realtime, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const hash = (value: string): string =>
    createHmac('sha256', deps.tokenSecret).update(value).digest('hex');

  const failedPairings: number[] = [];

  async function mappingOf(shopId: string): Promise<PrinterMapping> {
    const found = await repo.getMapping(shopId);
    return { black_white: found.black_white ?? null, color: found.color ?? null };
  }

  /** Works out which printer and duplex mode a job needs now, or why it cannot be printed. */
  function resolve(
    job: JobRecord,
    mapping: PrinterMapping,
  ): { spec: PrintJobSpec } | { error: string } {
    const choice = mapping[job.spec.colorMode];
    if (!choice) {
      return {
        error: `No printer is assigned for ${MODE_LABEL[job.spec.colorMode]} printing. Choose one in Printing settings, then try again.`,
      };
    }
    if (job.spec.sides === 'double' && !choice.supportsDuplex) {
      return {
        error: `${choice.printerName} is not set up for 2-sided printing. Turn it on in Printing settings or print this order by hand.`,
      };
    }
    return {
      spec: {
        id: job.id,
        kind: job.kind,
        label: job.label,
        printerName: choice.printerName,
        color: job.spec.colorMode === 'color',
        duplex: duplexFor(job.spec.sides, job.spec.landscape),
        copies: job.spec.copies,
        paperSize: job.spec.paperSize,
        filePath: `/api/v1/agent/jobs/${job.id}/file`,
        fileBytes: job.fileBytes,
      },
    };
  }

  async function afterJobChange(job: JobRecord): Promise<void> {
    if (job.kind === 'test') {
      const latest = await repo.findJob(job.id);
      if (latest && (latest.status === 'done' || latest.status === 'failed')) {
        await storage.delete(latest.fileKey);
      }
      return;
    }
    if (!job.orderId) return;
    const jobs = await repo.jobsForOrder(job.orderId);
    const live = jobs.filter((j) => j.status !== 'cancelled');
    if (live.length > 0 && live.every((j) => j.status === 'done')) {
      await deps.orders().markPrinted(job.orderId);
    } else {
      await deps.orders().touch(job.orderId);
    }
  }

  /** Marks a job failed (if it is still open) and tells the shop. */
  async function failJob(job: JobRecord, error: string): Promise<void> {
    const changed = await repo.transitionJob(job.id, ['queued', 'sent', 'printing'], {
      status: 'failed',
      error,
      finishedAt: now(),
    });
    if (changed) await afterJobChange(job);
  }

  /** Hands a job to the agent, or fails it with a reason the owner can act on. */
  async function dispatch(job: JobRecord, device: DeviceRecord, mapping: PrinterMapping) {
    const resolved = resolve(job, mapping);
    if ('error' in resolved) {
      await failJob(job, resolved.error);
      return;
    }
    if (job.status === 'queued') {
      const moved = await repo.transitionJob(job.id, ['queued'], {
        status: 'sent',
        deviceId: device.id,
        sentAt: now(),
        incrementAttempts: true,
      });
      if (!moved) return; // someone else took it
    }
    realtime.agents.send(device.id, AGENT.jobNew, resolved.spec);
  }

  /** Sends everything the agent has not finished yet; safe to repeat (the agent ignores repeats). */
  async function flush(device: DeviceRecord): Promise<void> {
    const mapping = await mappingOf(device.shopId);
    for (const job of await repo.openJobs(device.shopId)) {
      await dispatch(job, device, mapping);
    }
  }

  async function statusOf(shopId: string): Promise<PrintingStatus> {
    const device = await repo.activeDevice(shopId);
    const mapping = await mappingOf(shopId);
    const printers = device?.printers ?? [];
    const connected = device ? await realtime.agents.isOnline(device.id) : false;

    const describe = (choice: PrinterChoice | null): MappedPrinter | null =>
      choice
        ? {
            printerName: choice.printerName,
            supportsDuplex: choice.supportsDuplex,
            missing: !printers.some((p) => p.name === choice.printerName),
          }
        : null;
    const black_white = describe(mapping.black_white);
    const color = describe(mapping.color);
    return {
      agent: device
        ? {
            id: device.id,
            name: device.name,
            version: device.version,
            connected,
            lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          }
        : null,
      printers,
      mapping: { black_white, color },
      ready: connected && !!black_white && !!color && !black_white.missing && !color.missing,
    };
  }

  async function testPage(shopName: string, mode: PrinterColorMode): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const body = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Printing test page', { x: 60, y: 760, size: 28, font });
    page.drawText(shopName, { x: 60, y: 728, size: 16, font: body });
    page.drawText(`Printer for ${MODE_LABEL[mode]} jobs`, { x: 60, y: 704, size: 14, font: body });
    page.drawText(now().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', {
      x: 60,
      y: 684,
      size: 11,
      font: body,
      color: rgb(0.4, 0.4, 0.4),
    });
    const bars = [rgb(0, 0, 0), rgb(0.85, 0.1, 0.1), rgb(0.1, 0.65, 0.2), rgb(0.1, 0.3, 0.85)];
    bars.forEach((color, i) =>
      page.drawRectangle({ x: 60 + i * 120, y: 540, width: 110, height: 90, color }),
    );
    page.drawText(
      mode === 'color'
        ? 'If this page shows four colours, colour printing works.'
        : 'This page should come out in black and white only.',
      { x: 60, y: 510, size: 12, font: body },
    );
    return Buffer.from(await doc.save());
  }

  return {
    // ---------- pairing ----------

    /** A 6-digit code the owner types into the printing app. Valid for 15 minutes, once. */
    async createPairingCode(tenant: { shopId: string; userId: string }): Promise<PairingCode> {
      const expiresAt = new Date(now().getTime() + PAIRING_TTL_MINUTES * 60_000);
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const created = await repo.createPairing({
          shopId: tenant.shopId,
          codeHash: hash(`pair:${code}`),
          createdBy: tenant.userId,
          expiresAt,
        });
        if (created) {
          await audit.record({
            actorType: 'user',
            actorId: tenant.userId,
            shopId: tenant.shopId,
            action: 'printing.pairing_code_created',
          });
          return { code, expiresAt: expiresAt.toISOString() };
        }
      }
      throw new Error('could not allocate a pairing code');
    },

    /** The printing app trades a valid code for its device token. */
    async pair(request: PairRequest): Promise<PairResponse> {
      const at = now();
      const hourAgo = at.getTime() - 3_600_000;
      while (failedPairings.length > 0 && failedPairings[0]! < hourAgo) failedPairings.shift();
      if (failedPairings.length >= MAX_FAILED_PAIRINGS_PER_HOUR) {
        throw new HttpError(429, 'Too many wrong codes. Try again later.', 'rate_limited');
      }

      const shopId = await repo.claimPairing(hash(`pair:${request.code}`), at);
      if (!shopId) {
        failedPairings.push(at.getTime());
        throw new HttpError(
          400,
          'That code is not valid or has expired. Get a new one from the dashboard.',
          'invalid_code',
        );
      }

      const token = randomBytes(32).toString('base64url');
      const device = await repo.createDevice({
        shopId,
        name: request.deviceName,
        tokenHash: hash(`device:${token}`),
        version: request.version,
      });
      for (const oldId of await repo.revokeOthers(shopId, device.id, at)) {
        realtime.agents.send(oldId, AGENT.revoked, {});
        realtime.agents.disconnect(oldId);
      }
      await audit.record({
        actorType: 'agent',
        actorId: device.id,
        shopId,
        action: 'printing.agent_paired',
        metadata: { name: device.name, version: request.version },
      });
      return {
        deviceId: device.id,
        token,
        shopName: (await deps.findShopName(shopId)) ?? '',
      };
    },

    /** Socket and HTTP authentication: the device behind a token, or null. */
    async authenticate(token: string): Promise<{ deviceId: string; shopId: string } | null> {
      const device = await repo.findDeviceByTokenHash(hash(`device:${token}`));
      return device ? { deviceId: device.id, shopId: device.shopId } : null;
    },

    async removeAgent(tenant: { shopId: string; userId: string }, deviceId: string) {
      const removed = await repo.revokeDevice(tenant.shopId, deviceId, now());
      if (!removed) throw new HttpError(404, 'Printing app not found', 'not_found');
      realtime.agents.send(deviceId, AGENT.revoked, {});
      realtime.agents.disconnect(deviceId);
      await audit.record({
        actorType: 'user',
        actorId: tenant.userId,
        shopId: tenant.shopId,
        action: 'printing.agent_removed',
        entityId: deviceId,
      });
    },

    // ---------- the agent's connection ----------

    /** The agent says who it is and what printers it has; it gets its pending work back. */
    async onHello(agent: { deviceId: string; shopId: string }, payload: unknown) {
      const hello = AgentHello.parse(payload);
      await repo.saveHello(agent.deviceId, { ...hello, at: now() });

      const current = await mappingOf(agent.shopId);
      const mapped = autoMapPrinters(hello.printers, current);
      for (const mode of ['black_white', 'color'] as const) {
        if (mapped[mode] && !current[mode]) await repo.setMapping(agent.shopId, mode, mapped[mode]);
      }

      const device = await repo.findDevice(agent.deviceId);
      if (device) await flush(device);
      return { shopName: (await deps.findShopName(agent.shopId)) ?? '' };
    },

    async onJobStatus(agent: { deviceId: string; shopId: string }, payload: unknown) {
      const update = JobStatusUpdate.parse(payload);
      const job = await repo.findJob(update.jobId);
      if (!job || job.shopId !== agent.shopId) throw new Error('not_found');
      await repo.touch(agent.deviceId, now());

      const changed =
        update.status === 'printing'
          ? await repo.transitionJob(job.id, ['queued', 'sent'], { status: 'printing' })
          : update.status === 'done'
            ? await repo.transitionJob(job.id, ['queued', 'sent', 'printing'], {
                status: 'done',
                error: null,
                finishedAt: now(),
              })
            : await repo.transitionJob(job.id, ['queued', 'sent', 'printing'], {
                status: 'failed',
                error: update.error ?? 'The printer did not accept the job',
                finishedAt: now(),
              });
      if (changed) await afterJobChange(job);
    },

    /** The PDF of one of this device's jobs; other shops' jobs are simply not found. */
    async openJobFile(agent: { deviceId: string; shopId: string }, jobId: string) {
      const job = await repo.findJob(jobId);
      if (
        !job ||
        job.shopId !== agent.shopId ||
        !['queued', 'sent', 'printing'].includes(job.status) ||
        !(await storage.exists(job.fileKey))
      ) {
        throw new HttpError(404, 'File not found', 'not_found');
      }
      return { stream: storage.createReadStream(job.fileKey), bytes: job.fileBytes };
    },

    // ---------- the owner's dashboard ----------

    status: statusOf,

    async setMapping(tenant: { shopId: string; userId: string }, body: PrinterMappingBody) {
      const device = await repo.activeDevice(tenant.shopId);
      if (!device) throw new HttpError(409, 'Install the printing app first', 'no_agent');
      const known = new Set((device.printers ?? []).map((p) => p.name));
      for (const mode of ['black_white', 'color'] as const) {
        const choice = body[mode];
        if (choice && !known.has(choice.printerName)) {
          throw new HttpError(
            400,
            `"${choice.printerName}" is not on the shop PC`,
            'unknown_printer',
          );
        }
      }
      for (const mode of ['black_white', 'color'] as const) {
        await repo.setMapping(tenant.shopId, mode, body[mode]);
      }
      await audit.record({
        actorType: 'user',
        actorId: tenant.userId,
        shopId: tenant.shopId,
        action: 'printing.mapping_updated',
        metadata: {
          black_white: body.black_white?.printerName ?? null,
          color: body.color?.printerName ?? null,
        },
      });
      await flush(device);
      return statusOf(tenant.shopId);
    },

    /** One test page to each assigned printer. */
    async sendTestPages(tenant: { shopId: string; userId: string }) {
      const device = await repo.activeDevice(tenant.shopId);
      if (!device) throw new HttpError(409, 'Install the printing app first', 'no_agent');
      if (!(await realtime.agents.isOnline(device.id))) {
        throw new HttpError(409, 'The printing app is not connected right now', 'agent_offline');
      }
      const mapping = await mappingOf(tenant.shopId);
      const modes = (['black_white', 'color'] as const).filter((m) => mapping[m]);
      if (modes.length === 0) {
        throw new HttpError(409, 'Choose a printer first', 'no_printer');
      }
      const shopName = (await deps.findShopName(tenant.shopId)) ?? 'Your shop';
      const jobs = [];
      for (const mode of modes) {
        const pdf = await testPage(shopName, mode);
        const key = `print/${tenant.shopId}/test/${randomBytes(8).toString('hex')}.pdf`;
        await storage.put(key, pdf);
        jobs.push({
          shopId: tenant.shopId,
          kind: 'test' as const,
          label: `Test page (${MODE_LABEL[mode]})`,
          fileKey: key,
          fileBytes: pdf.length,
          spec: {
            colorMode: mode,
            sides: 'single',
            copies: 1,
            paperSize: 'A4',
            landscape: false,
          } satisfies JobSpec,
        });
      }
      const created = await repo.createJobs(jobs);
      for (const job of created) await dispatch(job, device, mapping);
      return { sent: created.length };
    },

    // ---------- orders ----------

    /**
     * The shop pressed Print. With a printing app set up, one job per document is queued for it
     * (and sent now if it is connected); without one, nothing happens and the shop prints by hand.
     */
    async submitOrder(input: SubmitOrderInput): Promise<'agent' | 'manual'> {
      const device = await repo.activeDevice(input.shopId);
      if (!device) return 'manual';
      const created = await repo.createJobs(
        input.items.map((item) => ({
          shopId: input.shopId,
          kind: 'order' as const,
          orderId: input.orderId,
          orderItemId: item.itemId,
          label: `${input.orderLabel} · ${item.name}`,
          fileKey: item.fileKey,
          fileBytes: item.fileBytes,
          spec: {
            colorMode: item.colorMode,
            sides: item.sides,
            copies: item.copies,
            paperSize: item.paperSize,
            landscape: item.landscape,
          },
        })),
      );
      const mapping = await mappingOf(input.shopId);
      if (await realtime.agents.isOnline(device.id)) {
        for (const job of created) await dispatch(job, device, mapping);
      }
      return 'agent';
    },

    /** Failed documents go back in the queue. */
    async retryOrder(shopId: string, orderId: string): Promise<void> {
      const device = await repo.activeDevice(shopId);
      if (!device) throw new HttpError(409, 'The printing app is not set up', 'no_agent');
      const count = await repo.requeueFailed(orderId);
      if (count === 0)
        throw new HttpError(409, 'Nothing to retry for this order', 'nothing_to_retry');
      if (await realtime.agents.isOnline(device.id)) await flush(device);
      await deps.orders().touch(orderId);
    },

    /** The shop prints this order by hand instead. */
    async cancelOrder(orderId: string): Promise<void> {
      await repo.cancelOpenJobs(orderId, now());
      await deps.orders().touch(orderId);
    },

    /** How printing is going for each of these orders (only orders that have print jobs appear). */
    async statesFor(shopId: string, orderIds: string[]): Promise<Map<string, OrderPrintState>> {
      const jobs = await repo.jobsForOrders(orderIds);
      const states = new Map<string, OrderPrintState>();
      if (jobs.length === 0) return states;
      const device = await repo.activeDevice(shopId);
      const agentOnline = device ? await realtime.agents.isOnline(device.id) : false;

      const byOrder = new Map<string, JobRecord[]>();
      for (const job of jobs) {
        if (!job.orderId) continue;
        byOrder.set(job.orderId, [...(byOrder.get(job.orderId) ?? []), job]);
      }
      for (const [orderId, list] of byOrder) {
        const failed = list.find((j) => j.status === 'failed');
        const state: OrderPrintState['state'] = failed
          ? 'failed'
          : list.every((j) => j.status === 'done')
            ? 'done'
            : list.some((j) => j.status === 'printing' || j.status === 'sent')
              ? 'printing'
              : 'waiting';
        states.set(orderId, { state, error: failed?.error ?? null, agentOnline });
      }
      return states;
    },

    // ---------- housekeeping (scheduled) ----------

    /** Fails jobs the agent took but never finished and clears old rows. */
    async sweep(): Promise<{ failed: number }> {
      const at = now();
      const stale = await repo.staleJobs(new Date(at.getTime() - deps.staleJobMinutes * 60_000));
      for (const job of stale) {
        logger.warn({ jobId: job.id }, 'print job went silent');
        await failJob(
          job,
          'The printing app did not finish this in time. Check the printer, then retry.',
        );
      }
      await repo.purgePairings(new Date(at.getTime() - 24 * 3_600_000));
      await repo.deleteFinishedJobsBefore(new Date(at.getTime() - 48 * 3_600_000));
      return { failed: stale.length };
    },
  };
}

export type PrintingService = ReturnType<typeof createPrintingService>;
