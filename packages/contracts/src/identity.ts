import { z } from 'zod';

export const PlatformRole = z.enum(['user', 'platform_admin']);
export type PlatformRole = z.infer<typeof PlatformRole>;

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  platformRole: PlatformRole,
});
export type AuthUser = z.infer<typeof AuthUser>;

export const MeResponse = z.object({ user: AuthUser });
export type MeResponse = z.infer<typeof MeResponse>;
