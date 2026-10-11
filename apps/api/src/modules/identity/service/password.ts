import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 10;

/** argon2id with the library's default (OWASP-aligned) parameters. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash so login takes the same time whether or not the email
 * exists (prevents user enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(await dummyHash, password);
}
