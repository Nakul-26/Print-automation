import type { Logger } from '../../../platform/observability/logger.js';
import type { Audit } from '../../audit/index.js';

/** What retention needs from the documents module. */
export interface DocumentsPort {
  purgeExpired(at: Date): Promise<{ count: number; bytes: number }>;
  storedUploads(): Promise<
    { uploadId: string; orderId: string | null; createdAt: Date; bytes: number }[]
  >;
  purgeUploads(ids: string[]): Promise<{ count: number; bytes: number }>;
}

/** What retention needs from the orders module. */
export interface OrdersPort {
  retire(
    at: Date,
    stuckAfterMinutes: number,
  ): Promise<{ expired: number; failed: number; purgedOrders: number; bytes: number }>;
  printFileUsage(): Promise<{ orderId: string; status: string; createdAt: Date; bytes: number }[]>;
  evictFiles(orderIds: string[], reason: string): Promise<{ count: number; bytes: number }>;
}

export interface RetentionDeps {
  documents: DocumentsPort;
  orders: OrdersPort;
  audit: Audit;
  logger: Logger;
  maxBytes: () => Promise<number> | number;
  highWatermark: number;
  lowWatermark: number;
  stuckProcessingMinutes: number;
  now?: () => Date;
}

export interface SweepResult {
  expiredOrders: number;
  failedOrders: number;
  purgedUploads: number;
  purgedOrderFiles: number;
  freedBytes: number;
  evictedOrders: number;
  evictedBytes: number;
}

const OPEN_STATUSES = new Set(['pending', 'accepted', 'printing']);

export const EVICTION_REASON = 'Files were removed to free up storage';

interface Unit {
  key: string;
  uploadIds: string[];
  orderId: string | null;
  bytes: number;
  createdAt: Date;
  /** An order that may still be printed. These go last. */
  open: boolean;
}

/** Deletes what is past its time, and when storage is nearly full, deletes the oldest files first. */
export function createRetentionService(deps: RetentionDeps) {
  const now = deps.now ?? (() => new Date());

  /**
   * Above the high watermark, remove whole units (an upload with its order's print files) until
   * usage is under the low watermark. Abandoned uploads and finished orders go before orders that
   * may still be printed; within each group the oldest go first.
   */
  async function enforceQuota(): Promise<{ orders: number; uploads: number; bytes: number }> {
    const max = await deps.maxBytes();
    const [uploads, printFiles] = await Promise.all([
      deps.documents.storedUploads(),
      deps.orders.printFileUsage(),
    ]);
    const total =
      uploads.reduce((sum, u) => sum + u.bytes, 0) + printFiles.reduce((s, p) => s + p.bytes, 0);
    if (total <= max * deps.highWatermark) return { orders: 0, uploads: 0, bytes: 0 };

    const status = new Map(printFiles.map((p) => [p.orderId, p.status]));
    const units = new Map<string, Unit>();
    const unitFor = (key: string, orderId: string | null, createdAt: Date): Unit => {
      let unit = units.get(key);
      if (!unit) {
        // An order without print files yet is still being prepared, so it counts as open.
        const s = orderId ? status.get(orderId) : undefined;
        unit = {
          key,
          uploadIds: [],
          orderId,
          bytes: 0,
          createdAt,
          open: orderId !== null && (s === undefined || OPEN_STATUSES.has(s)),
        };
        units.set(key, unit);
      }
      if (createdAt < unit.createdAt) unit.createdAt = createdAt;
      return unit;
    };
    for (const u of uploads) {
      const unit = unitFor(u.orderId ?? `upload:${u.uploadId}`, u.orderId, u.createdAt);
      unit.uploadIds.push(u.uploadId);
      unit.bytes += u.bytes;
    }
    for (const p of printFiles) {
      unitFor(p.orderId, p.orderId, p.createdAt).bytes += p.bytes;
    }

    const ordered = [...units.values()].sort(
      (a, b) => Number(a.open) - Number(b.open) || a.createdAt.getTime() - b.createdAt.getTime(),
    );
    const target = max * deps.lowWatermark;
    let remaining = total;
    const chosen: Unit[] = [];
    for (const unit of ordered) {
      if (remaining <= target) break;
      chosen.push(unit);
      remaining -= unit.bytes;
    }

    const uploadIds = chosen.flatMap((u) => u.uploadIds);
    const orderIds = chosen.flatMap((u) => (u.orderId ? [u.orderId] : []));
    const removedUploads = await deps.documents.purgeUploads(uploadIds);
    const removedOrders = await deps.orders.evictFiles(orderIds, EVICTION_REASON);

    for (const unit of chosen.filter((u) => u.orderId)) {
      await deps.audit.record({
        actorType: 'system',
        action: 'order.files_evicted',
        entity: 'order',
        entityId: unit.orderId!,
        metadata: { bytes: unit.bytes, wasOpen: unit.open },
      });
    }
    return {
      orders: removedOrders.count,
      uploads: removedUploads.count,
      bytes: removedUploads.bytes + removedOrders.bytes,
    };
  }

  return {
    /** One pass of housekeeping. Safe to run at any time, and repeatedly. */
    async sweep(): Promise<SweepResult> {
      const at = now();
      const orders = await deps.orders.retire(at, deps.stuckProcessingMinutes);
      const uploads = await deps.documents.purgeExpired(at);
      const evicted = await enforceQuota();

      const result: SweepResult = {
        expiredOrders: orders.expired,
        failedOrders: orders.failed,
        purgedUploads: uploads.count,
        purgedOrderFiles: orders.purgedOrders,
        freedBytes: orders.bytes + uploads.bytes + evicted.bytes,
        evictedOrders: evicted.orders,
        evictedBytes: evicted.bytes,
      };
      const worked =
        result.expiredOrders +
        result.failedOrders +
        result.purgedUploads +
        result.purgedOrderFiles +
        result.evictedOrders +
        evicted.uploads;
      if (worked > 0) {
        deps.logger.info(result, 'retention sweep');
        await deps.audit.record({
          actorType: 'system',
          action: 'retention.sweep',
          metadata: { ...result },
        });
      }
      return result;
    },
  };
}

export type RetentionService = ReturnType<typeof createRetentionService>;
