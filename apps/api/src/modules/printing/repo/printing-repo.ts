import type { AgentPrinter } from '@print/contracts';
import type { PrinterChoice, PrinterColorMode } from '@print/domain';
import type { Db } from '../../../platform/db/client.js';
import type { PrintJobStatus } from '../../../generated/prisma/enums.js';

export interface DeviceRecord {
  id: string;
  shopId: string;
  name: string;
  version: string | null;
  printers: AgentPrinter[] | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/** What to print and how; the printer itself is chosen when the job is sent. */
export interface JobSpec {
  colorMode: PrinterColorMode;
  sides: 'single' | 'double';
  copies: number;
  paperSize: 'A4' | 'A3';
  landscape: boolean;
}

export interface JobRecord {
  id: string;
  shopId: string;
  kind: 'order' | 'test';
  orderId: string | null;
  orderItemId: string | null;
  label: string;
  status: PrintJobStatus;
  fileKey: string;
  fileBytes: number | null;
  spec: JobSpec;
  deviceId: string | null;
  attempts: number;
  error: string | null;
  updatedAt: Date;
}

export interface NewJob {
  shopId: string;
  kind: 'order' | 'test';
  orderId?: string;
  orderItemId?: string;
  label: string;
  fileKey: string;
  fileBytes: number | null;
  spec: JobSpec;
}

const toDevice = (row: unknown): DeviceRecord => row as DeviceRecord;
const toJob = (row: unknown): JobRecord => row as JobRecord;

/** The only code in this module that touches the database. */
export function createPrintingRepo(db: Db) {
  return {
    // ---- pairing ----
    /** Replaces any unused code the shop still has; the code is hashed, never stored. */
    async createPairing(input: {
      shopId: string;
      codeHash: string;
      createdBy: string;
      expiresAt: Date;
    }): Promise<boolean> {
      try {
        await db.$transaction([
          db.agentPairing.deleteMany({ where: { shopId: input.shopId, usedAt: null } }),
          db.agentPairing.create({ data: input }),
        ]);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'P2002') return false; // hash already used once
        throw err;
      }
    },

    /** Marks a valid code as used. Exactly one caller can win it. Returns the shop, or null. */
    async claimPairing(codeHash: string, now: Date): Promise<string | null> {
      const row = await db.agentPairing.findUnique({ where: { codeHash } });
      if (!row || row.usedAt || row.expiresAt <= now) return null;
      const { count } = await db.agentPairing.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      return count === 1 ? row.shopId : null;
    },

    async purgePairings(before: Date): Promise<void> {
      await db.agentPairing.deleteMany({ where: { expiresAt: { lt: before } } });
    },

    // ---- devices ----
    async createDevice(input: {
      shopId: string;
      name: string;
      tokenHash: string;
      version: string;
    }): Promise<DeviceRecord> {
      return toDevice(await db.agentDevice.create({ data: input }));
    },

    /** Removes the shop's other devices: one printing app per shop. Returns their ids. */
    async revokeOthers(shopId: string, keepId: string, at: Date): Promise<string[]> {
      const others = await db.agentDevice.findMany({
        where: { shopId, revokedAt: null, id: { not: keepId } },
        select: { id: true },
      });
      await db.agentDevice.updateMany({
        where: { id: { in: others.map((d) => d.id) } },
        data: { revokedAt: at },
      });
      return others.map((d) => d.id);
    },

    async revokeDevice(shopId: string, id: string, at: Date): Promise<boolean> {
      const { count } = await db.agentDevice.updateMany({
        where: { id, shopId, revokedAt: null },
        data: { revokedAt: at },
      });
      return count === 1;
    },

    async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
      const row = await db.agentDevice.findUnique({ where: { tokenHash } });
      return row && !row.revokedAt ? toDevice(row) : null;
    },

    /** Ids of shops that have a printing app linked (online or not). */
    async shopsWithDevice(): Promise<Set<string>> {
      const rows = await db.agentDevice.findMany({
        where: { revokedAt: null },
        select: { shopId: true },
        distinct: ['shopId'],
      });
      return new Set(rows.map((r) => r.shopId));
    },

    async activeDevice(shopId: string): Promise<DeviceRecord | null> {
      const row = await db.agentDevice.findFirst({
        where: { shopId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      return row ? toDevice(row) : null;
    },

    async findDevice(id: string): Promise<DeviceRecord | null> {
      const row = await db.agentDevice.findUnique({ where: { id } });
      return row && !row.revokedAt ? toDevice(row) : null;
    },

    async saveHello(id: string, data: { version: string; printers: AgentPrinter[]; at: Date }) {
      await db.agentDevice.updateMany({
        where: { id, revokedAt: null },
        data: { version: data.version, printers: data.printers as never, lastSeenAt: data.at },
      });
    },

    async touch(id: string, at: Date): Promise<void> {
      await db.agentDevice.updateMany({ where: { id }, data: { lastSeenAt: at } });
    },

    // ---- printer mapping ----
    async getMapping(shopId: string): Promise<Partial<Record<PrinterColorMode, PrinterChoice>>> {
      const rows = await db.shopPrinter.findMany({ where: { shopId } });
      const mapping: Partial<Record<PrinterColorMode, PrinterChoice>> = {};
      for (const row of rows) {
        mapping[row.colorMode as PrinterColorMode] = {
          printerName: row.printerName,
          supportsDuplex: row.supportsDuplex,
        };
      }
      return mapping;
    },

    async setMapping(
      shopId: string,
      colorMode: PrinterColorMode,
      choice: PrinterChoice | null,
    ): Promise<void> {
      if (!choice) {
        await db.shopPrinter.deleteMany({ where: { shopId, colorMode } });
        return;
      }
      await db.shopPrinter.upsert({
        where: { shopId_colorMode: { shopId, colorMode } },
        create: { shopId, colorMode, ...choice },
        update: choice,
      });
    },

    // ---- jobs ----
    async createJobs(jobs: NewJob[]): Promise<JobRecord[]> {
      return db
        .$transaction(
          jobs.map((job) =>
            db.printJob.create({
              data: {
                shopId: job.shopId,
                kind: job.kind,
                orderId: job.orderId ?? null,
                orderItemId: job.orderItemId ?? null,
                label: job.label,
                fileKey: job.fileKey,
                fileBytes: job.fileBytes,
                spec: job.spec as never,
              },
            }),
          ),
        )
        .then((rows) => rows.map(toJob));
    },

    async findJob(id: string): Promise<JobRecord | null> {
      const row = await db.printJob.findUnique({ where: { id } });
      return row ? toJob(row) : null;
    },

    async jobsForOrder(orderId: string): Promise<JobRecord[]> {
      return (
        await db.printJob.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })
      ).map(toJob);
    },

    async jobsForOrders(orderIds: string[]): Promise<JobRecord[]> {
      if (orderIds.length === 0) return [];
      return (
        await db.printJob.findMany({
          where: { orderId: { in: orderIds }, status: { not: 'cancelled' } },
          orderBy: { createdAt: 'asc' },
        })
      ).map(toJob);
    },

    /** Jobs the agent still has to receive or finish. */
    async openJobs(shopId: string): Promise<JobRecord[]> {
      return (
        await db.printJob.findMany({
          where: { shopId, status: { in: ['queued', 'sent'] } },
          orderBy: { createdAt: 'asc' },
        })
      ).map(toJob);
    },

    /** Moves a job forward only from one of the expected states (so duplicates are harmless). */
    async transitionJob(
      id: string,
      from: PrintJobStatus[],
      data: {
        status: PrintJobStatus;
        error?: string | null;
        deviceId?: string;
        sentAt?: Date;
        finishedAt?: Date;
        incrementAttempts?: boolean;
      },
    ): Promise<boolean> {
      const { incrementAttempts, ...fields } = data;
      const { count } = await db.printJob.updateMany({
        where: { id, status: { in: from } },
        data: { ...fields, ...(incrementAttempts ? { attempts: { increment: 1 } } : {}) },
      });
      return count === 1;
    },

    /** Failed jobs of an order go back in the queue. Returns how many. */
    async requeueFailed(orderId: string): Promise<number> {
      const { count } = await db.printJob.updateMany({
        where: { orderId, status: 'failed' },
        data: { status: 'queued', error: null, finishedAt: null, deviceId: null },
      });
      return count;
    },

    /** The shop gives up on the app for this order: whatever is not already printing stops. */
    async cancelOpenJobs(orderId: string, at: Date): Promise<number> {
      const { count } = await db.printJob.updateMany({
        where: { orderId, status: { in: ['queued', 'sent', 'failed'] } },
        data: { status: 'cancelled', finishedAt: at },
      });
      return count;
    },

    /** Jobs that were handed to the agent but never finished. */
    async staleJobs(before: Date): Promise<JobRecord[]> {
      return (
        await db.printJob.findMany({
          where: { status: { in: ['sent', 'printing'] }, updatedAt: { lt: before } },
        })
      ).map(toJob);
    },

    async deleteFinishedJobsBefore(before: Date): Promise<void> {
      await db.printJob.deleteMany({
        where: { status: { in: ['done', 'failed', 'cancelled'] }, updatedAt: { lt: before } },
      });
    },
  };
}

export type PrintingRepo = ReturnType<typeof createPrintingRepo>;
