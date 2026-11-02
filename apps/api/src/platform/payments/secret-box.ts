import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Encrypts small secrets (a shop's payment gateway key) before they go into the database, so a
 * database dump alone does not expose them. AES-256-GCM, with the key derived from a server secret.
 * Changing that server secret makes every stored value unreadable; the shop then enters its keys again.
 */
export function createSecretBox(serverSecret: string) {
  const key = Buffer.from(
    hkdfSync('sha256', serverSecret, 'print-platform', 'shop-payment-keys', 32),
  );
  return {
    seal(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), body]
        .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
        .join('.');
    },
    /** Returns null when the value is damaged or was sealed with a different server secret. */
    open(sealed: string): string | null {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || !body) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([
          decipher.update(Buffer.from(body, 'base64url')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

export type SecretBox = ReturnType<typeof createSecretBox>;
