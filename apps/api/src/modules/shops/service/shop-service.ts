import { ShopSlug } from '@print/contracts';
import type { ShopRole, ShopStatus } from '../../../platform/db/enums.js';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Audit } from '../../audit/index.js';
import type { MembershipRecord, ShopRecord, ShopRepo } from '../repo/shop-repo.js';

/** Slugs that would collide with application routes. */
const RESERVED_SLUGS = new Set(['admin', 'api', 'owner', 'login', 'static', 'assets', 'health']);

export type ShopAction = 'approve' | 'suspend' | 'reactivate';

const ALLOWED_FROM: Record<ShopAction, ShopStatus[]> = {
  approve: ['pending_approval'],
  suspend: ['pending_approval', 'active'],
  reactivate: ['suspended'],
};
const PAST_TENSE: Record<ShopAction, string> = {
  approve: 'approved',
  suspend: 'suspended',
  reactivate: 'reactivated',
};
const RESULT: Record<ShopAction, ShopStatus> = {
  approve: 'active',
  suspend: 'suspended',
  reactivate: 'active',
};

export function createShopService(deps: {
  repo: ShopRepo;
  audit: Audit;
  /** Called after a shop is suspended so its live connections can be closed. */
  onSuspended?: (shopId: string) => void;
}) {
  const { repo, audit } = deps;

  /** Throws unless the slug is well formed, not reserved and not taken. Returns it. */
  async function checkSlug(value: string): Promise<string> {
    const slug = ShopSlug.safeParse(value);
    if (!slug.success || RESERVED_SLUGS.has(slug.data)) {
      throw new HttpError(400, 'Invalid or reserved shop slug', 'invalid_slug');
    }
    if (await repo.findBySlug(slug.data)) {
      throw new HttpError(409, 'A shop with this slug already exists', 'slug_taken');
    }
    return slug.data;
  }

  return {
    checkSlug,

    async createShop(input: {
      name: string;
      slug: string;
      status?: ShopStatus;
      address?: string;
      contactPhone?: string;
      actorId?: string | null;
    }): Promise<ShopRecord> {
      const slug = await checkSlug(input.slug);
      const shop = await repo.createShop({
        slug,
        name: input.name.trim(),
        status: input.status ?? 'pending_approval',
        ...(input.address ? { address: input.address.trim() } : {}),
        ...(input.contactPhone ? { contactPhone: input.contactPhone.trim() } : {}),
      });
      await audit.record({
        actorType: input.actorId ? 'user' : 'system',
        actorId: input.actorId ?? null,
        shopId: shop.id,
        action: 'shop.created',
        entity: 'shop',
        entityId: shop.id,
      });
      return shop;
    },

    async addMember(input: {
      shopId: string;
      userId: string;
      role: ShopRole;
      actorId?: string | null;
    }): Promise<void> {
      await repo.addMember(input.shopId, input.userId, input.role);
      await audit.record({
        actorType: input.actorId ? 'user' : 'system',
        actorId: input.actorId ?? null,
        shopId: input.shopId,
        action: 'shop.member_added',
        entity: 'user',
        entityId: input.userId,
        metadata: { role: input.role },
      });
    },

    /** Approve, suspend or reactivate a shop. A suspension also ends its live connections. */
    async changeStatus(input: {
      shopId: string;
      action: ShopAction;
      actorId: string;
      reason?: string | undefined;
    }): Promise<ShopRecord> {
      const shop = await repo.findById(input.shopId);
      if (!shop) throw new HttpError(404, 'Shop not found', 'not_found');
      if (!ALLOWED_FROM[input.action].includes(shop.status)) {
        throw new HttpError(
          409,
          `This shop is ${shop.status.replace('_', ' ')}, so it cannot be ${PAST_TENSE[input.action]}`,
          'invalid_transition',
        );
      }
      const updated = await repo.setStatus(shop.id, RESULT[input.action]);
      if (!updated) throw new HttpError(404, 'Shop not found', 'not_found');
      if (updated.status === 'suspended') deps.onSuspended?.(shop.id);
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: shop.id,
        action: `shop.${PAST_TENSE[input.action]}`,
        entity: 'shop',
        entityId: shop.id,
        metadata: { from: shop.status, to: updated.status, reason: input.reason ?? null },
      });
      return updated;
    },

    async setLimits(input: {
      shopId: string;
      storageQuotaBytes?: number | null | undefined;
      flags?: Partial<ShopRecord['flags']> | undefined;
      actorId: string;
    }): Promise<ShopRecord> {
      const updated = await repo.setLimits(input.shopId, {
        ...(input.storageQuotaBytes !== undefined
          ? { storageQuotaBytes: input.storageQuotaBytes }
          : {}),
        ...(input.flags ? { flags: input.flags } : {}),
      });
      if (!updated) throw new HttpError(404, 'Shop not found', 'not_found');
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: updated.id,
        action: 'shop.limits_changed',
        entity: 'shop',
        entityId: updated.id,
        metadata: {
          storageQuotaBytes: updated.storageQuotaBytes,
          flags: updated.flags,
        },
      });
      return updated;
    },

    listForUser(userId: string): Promise<MembershipRecord[]> {
      return repo.listMembershipsForUser(userId);
    },
  };
}

export type ShopService = ReturnType<typeof createShopService>;
