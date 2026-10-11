/** Authenticated caller, set by the identity module's middleware. */
export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  platformRole: 'user' | 'platform_admin';
  sessionId: string;
}

/**
 * The shop a request is acting on, set by shop-access middleware.
 * Repositories for shop-owned tables take this as a required argument so a query
 * cannot be written without naming a shop.
 */
export interface TenantContext {
  shopId: string;
  userId: string;
  role: 'owner' | 'staff';
}
