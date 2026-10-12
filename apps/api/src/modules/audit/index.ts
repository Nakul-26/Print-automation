import type { Db } from '../../platform/db/client.js';
import type { Logger } from '../../platform/observability/logger.js';

export interface AuditEntry {
  actorType: 'user' | 'system' | 'agent' | 'anonymous';
  actorId?: string | null;
  shopId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  at: Date;
  action: string;
  actorType: string;
  shopId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface Audit {
  record(entry: AuditEntry): Promise<void>;
  /** The newest entries first, optionally for one shop. For the platform admin's activity view. */
  recent(options: { shopId?: string; limit: number }): Promise<AuditRow[]>;
}

/**
 * Append-only audit trail. A failure to write the audit row is logged but never breaks
 * the user's request.
 */
export function createAudit({ db, logger }: { db: Db; logger: Logger }): Audit {
  return {
    async recent({ shopId, limit }) {
      const rows = await db.auditLog.findMany({
        ...(shopId ? { where: { shopId } } : {}),
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        at: r.createdAt,
        action: r.action,
        actorType: r.actorType,
        shopId: r.shopId,
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      }));
    },

    async record(entry) {
      try {
        await db.auditLog.create({
          data: {
            actorType: entry.actorType,
            actorId: entry.actorId ?? null,
            shopId: entry.shopId ?? null,
            action: entry.action,
            entity: entry.entity ?? null,
            entityId: entry.entityId ?? null,
            metadata: (entry.metadata ?? undefined) as never,
          },
        });
      } catch (err) {
        logger.error({ err, action: entry.action }, 'failed to write audit entry');
      }
    },
  };
}
