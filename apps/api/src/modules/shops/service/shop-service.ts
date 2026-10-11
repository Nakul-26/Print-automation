import { ShopSlug } from '@print/contracts';
import type { ShopRole, ShopStatus } from '../../../platform/db/enums.js';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Audit } from '../../audit/index.js';
import type { MembershipRecord, ShopRecord, ShopRepo } from '../repo/shop-repo.js';

/** Slugs that would collide with application routes. */
const RESERVED_SLUGS = new Set(['admin', 'api', 'owner', 'login', 'static', 'assets', 'health']);

export function createShopService(deps: { repo: ShopRepo; audit: Audit }) {
  const { repo, audit } = deps;

  return {
    async createShop(input: {
      name: string;
      slug: string;
      status?: ShopStatus;
      actorId?: string | null;
    }): Promise<ShopRecord> {
      const slug = ShopSlug.safeParse(input.slug);
      if (!slug.success || RESERVED_SLUGS.has(slug.data)) {
        throw new HttpError(400, 'Invalid or reserved shop slug', 'invalid_slug');
      }
      if (await repo.findBySlug(slug.data)) {
        throw new HttpError(409, 'A shop with this slug already exists', 'slug_taken');
      }
      const shop = await repo.createShop({
        slug: slug.data,
        name: input.name.trim(),
        status: input.status ?? 'pending_approval',
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

    listForUser(userId: string): Promise<MembershipRecord[]> {
      return repo.listMembershipsForUser(userId);
    },
  };
}

export type ShopService = ReturnType<typeof createShopService>;
