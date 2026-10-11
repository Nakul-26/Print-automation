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

export interface Audit {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Append-only audit trail. A failure to write the audit row is logged but never breaks
 * the user's request.
 */
export function createAudit({ db, logger }: { db: Db; logger: Logger }): Audit {
  return {
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
