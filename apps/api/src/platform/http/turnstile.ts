/** Cloudflare Turnstile: a privacy-friendly CAPTCHA that keeps bots from placing orders. */
export interface BotCheck {
  /** Public site key for the browser widget; null when checks are disabled. */
  readonly siteKey: string | null;
  /** True if the visitor passed. Always true when no secret is configured. */
  verify(token: string | undefined, ip: string | undefined): Promise<boolean>;
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createBotCheck(options: {
  secretKey?: string | undefined;
  siteKey?: string | undefined;
  fetchImpl?: typeof fetch;
}): BotCheck {
  const { secretKey, siteKey } = options;
  const doFetch = options.fetchImpl ?? fetch;

  if (!secretKey) return { siteKey: null, verify: async () => true };

  return {
    siteKey: siteKey ?? null,
    async verify(token, ip) {
      if (!token) return false;
      try {
        const body = new URLSearchParams({ secret: secretKey, response: token });
        if (ip) body.set('remoteip', ip);
        const res = await doFetch(VERIFY_URL, {
          method: 'POST',
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { success?: boolean };
        return data.success === true;
      } catch {
        // If the check cannot be completed, fail closed.
        return false;
      }
    },
  };
}
