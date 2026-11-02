import { randomBytes } from 'node:crypto';
import { ShopSlug, type AddStaffResponse, type StaffMember } from '@print/contracts';
import type { ShopRole, ShopStatus } from '../../../platform/db/enums.js';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Audit } from '../../audit/index.js';
import type {
  MembershipRecord,
  ShopMemberRecord,
  ShopRecord,
  ShopRepo,
} from '../repo/shop-repo.js';

/** What the shops module needs from the accounts side (wired in the composition root). */
export interface AccountsPort {
  findUserByEmail(email: string): Promise<{ id: string; name: string; email: string } | null>;
  createUser(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<{ id: string; name: string; email: string }>;
  /** Sets a new password and signs the person out everywhere. */
  setPassword(userId: string, password: string): Promise<void>;
}

/** A password the owner reads out or sends once; 16 characters from a secure random source. */
const generatePassword = (): string => randomBytes(12).toString('base64url');

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
  accounts: AccountsPort;
  /** Called after a shop is suspended so its live connections can be closed. */
  onSuspended?: (shopId: string) => void;
  /** Called after someone is removed from a shop, so their live connections close. */
  onMemberRemoved?: (userId: string) => void;
}) {
  const { repo, audit, accounts } = deps;

  const toMember = (m: ShopMemberRecord): StaffMember => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    role: m.role,
    since: m.since.toISOString(),
  });

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

    async setAdminNotes(input: {
      shopId: string;
      notes: string;
      actorId: string;
    }): Promise<ShopRecord> {
      const updated = await repo.setAdminNotes(input.shopId, input.notes);
      if (!updated) throw new HttpError(404, 'Shop not found', 'not_found');
      // The note itself stays out of the activity log; only the fact that it changed is recorded.
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: updated.id,
        action: 'shop.notes_updated',
        entity: 'shop',
        entityId: updated.id,
      });
      return updated;
    },

    /** The owner and staff of one shop. */
    async listStaff(shopId: string): Promise<StaffMember[]> {
      return (await repo.listMembers(shopId)).map(toMember);
    },

    /**
     * Gives someone staff access to the shop. A new person gets an account with a generated
     * password (returned once); someone who already has an account is simply linked and keeps
     * their own password.
     */
    async addStaff(input: {
      shopId: string;
      actorId: string;
      name: string;
      email: string;
    }): Promise<AddStaffResponse> {
      const email = input.email.trim().toLowerCase();
      const members = await repo.listMembers(input.shopId);
      if (members.some((m) => m.email === email)) {
        throw new HttpError(409, 'This person already works at your shop.', 'already_member');
      }
      const existing = await accounts.findUserByEmail(email);
      let password: string | null = null;
      let user = existing;
      if (!user) {
        password = generatePassword();
        user = await accounts.createUser({ email, name: input.name, password });
      }
      await repo.addMember(input.shopId, user.id, 'staff');
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: input.shopId,
        action: 'shop.staff_added',
        entity: 'user',
        entityId: user.id,
        metadata: { existingAccount: existing !== null },
      });
      const added = (await repo.listMembers(input.shopId)).find((m) => m.userId === user.id);
      if (!added) throw new HttpError(500, 'Could not add this person', 'internal_error');
      return { member: toMember(added), password, existingAccount: existing !== null };
    },

    /** Takes staff access away at once. The owner cannot be removed this way. */
    async removeStaff(input: { shopId: string; actorId: string; userId: string }): Promise<void> {
      const member = (await repo.listMembers(input.shopId)).find((m) => m.userId === input.userId);
      if (!member) throw new HttpError(404, 'Person not found', 'not_found');
      if (member.role !== 'staff') {
        throw new HttpError(409, 'The owner cannot be removed.', 'cannot_remove_owner');
      }
      await repo.removeMember(input.shopId, input.userId);
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: input.shopId,
        action: 'shop.staff_removed',
        entity: 'user',
        entityId: input.userId,
      });
      deps.onMemberRemoved?.(input.userId);
    },

    /**
     * Gives a staff member a new password (shown once) and signs them out. Only allowed for people
     * who work at this shop and nowhere else: otherwise one shop's owner could lock out, or take
     * over, an account that is also used at another shop.
     */
    async resetStaffPassword(input: {
      shopId: string;
      actorId: string;
      userId: string;
    }): Promise<string> {
      const member = (await repo.listMembers(input.shopId)).find((m) => m.userId === input.userId);
      if (!member) throw new HttpError(404, 'Person not found', 'not_found');
      if (member.role !== 'staff') {
        throw new HttpError(409, 'Owners reset their own password.', 'cannot_reset_owner');
      }
      if (member.platformRole !== 'user' || (await repo.countMemberships(input.userId)) !== 1) {
        throw new HttpError(
          409,
          'This person also has access elsewhere, so their password cannot be reset from your shop. Ask them to use their own account.',
          'shared_account',
        );
      }
      const password = generatePassword();
      await accounts.setPassword(input.userId, password);
      await audit.record({
        actorType: 'user',
        actorId: input.actorId,
        shopId: input.shopId,
        action: 'shop.staff_password_reset',
        entity: 'user',
        entityId: input.userId,
      });
      return password;
    },

    listForUser(userId: string): Promise<MembershipRecord[]> {
      return repo.listMembershipsForUser(userId);
    },
  };
}

export type ShopService = ReturnType<typeof createShopService>;
