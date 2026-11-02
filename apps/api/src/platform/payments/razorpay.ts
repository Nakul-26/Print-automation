import { createHmac, timingSafeEqual } from 'node:crypto';

/** A shop's gateway account. The key id is public (the browser needs it); the secret never leaves the server. */
export interface GatewayCredentials {
  keyId: string;
  keySecret: string;
}

export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface GatewayPayment {
  id: string;
  orderId: string;
  status: GatewayPaymentStatus;
  /** upi, card, netbanking, wallet, ... */
  method: string | null;
  amountPaise: number;
}

/** The gateway refused, was unreachable, or answered something unexpected. */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly info: { status?: number; code?: string; retryable: boolean },
  ) {
    super(message);
  }
}

/** What the platform needs from a payment provider. Razorpay today; another provider can sit behind the same port. */
export interface PaymentGateway {
  /** Proves the keys work (and says whether they are test or live keys) without moving money. */
  checkCredentials(c: GatewayCredentials): Promise<{ mode: 'test' | 'live' }>;
  createOrder(
    c: GatewayCredentials,
    input: {
      amountPaise: number;
      currency: string;
      receipt: string;
      notes?: Record<string, string>;
    },
  ): Promise<{ id: string }>;
  listOrderPayments(c: GatewayCredentials, gatewayOrderId: string): Promise<GatewayPayment[]>;
  /** Captures a payment that was only authorised (when the account is not set to capture automatically). */
  capture(
    c: GatewayCredentials,
    payment: { id: string; amountPaise: number; currency: string },
  ): Promise<void>;
  /** Refunds the whole payment. Asking twice for the same refund key is safe. */
  refund(
    c: GatewayCredentials,
    paymentId: string,
    input: { amountPaise: number; key: string },
  ): Promise<{ id: string }>;
  /** True only if the signature the browser returned was made by the gateway for this order and payment. */
  verifySignature(
    c: GatewayCredentials,
    input: { orderId: string; paymentId: string; signature: string },
  ): boolean;
}

const KEY_ID_PATTERN = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
export const isRazorpayKeyId = (value: string): boolean => KEY_ID_PATTERN.test(value);
const modeOf = (keyId: string): 'test' | 'live' =>
  keyId.startsWith('rzp_live_') ? 'live' : 'test';

export function createRazorpayGateway(
  options: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {},
): PaymentGateway {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? 'https://api.razorpay.com/v1';
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<T>(
    c: GatewayCredentials,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const auth = Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GatewayError('Could not reach the payment provider', { retryable: true });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { description?: string; code?: string } } | null)?.error;
      throw new GatewayError(err?.description ?? `The payment provider answered ${res.status}`, {
        status: res.status,
        ...(err?.code ? { code: err.code } : {}),
        // Rate limits and provider-side failures are worth retrying; a bad request or bad keys is not.
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return json as T;
  }

  return {
    async checkCredentials(c) {
      if (!KEY_ID_PATTERN.test(c.keyId)) {
        throw new GatewayError(
          'That does not look like a Razorpay Key ID (it starts with rzp_test_ or rzp_live_).',
          {
            retryable: false,
          },
        );
      }
      await call(c, 'GET', '/orders?count=1');
      return { mode: modeOf(c.keyId) };
    },

    async createOrder(c, input) {
      const order = await call<{ id?: string }>(c, 'POST', '/orders', {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        ...(input.notes ? { notes: input.notes } : {}),
      });
      if (!order?.id)
        throw new GatewayError('The payment provider did not return an order', { retryable: true });
      return { id: order.id };
    },

    async listOrderPayments(c, gatewayOrderId) {
      const res = await call<{
        items?: {
          id: string;
          order_id: string;
          status: GatewayPaymentStatus;
          method?: string;
          amount: number;
        }[];
      }>(c, 'GET', `/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
      return (res.items ?? []).map((p) => ({
        id: p.id,
        orderId: p.order_id,
        status: p.status,
        method: p.method ?? null,
        amountPaise: p.amount,
      }));
    },

    async capture(c, payment) {
      await call(c, 'POST', `/payments/${encodeURIComponent(payment.id)}/capture`, {
        amount: payment.amountPaise,
        currency: payment.currency,
      });
    },

    async refund(c, paymentId, input) {
      try {
        const res = await call<{ id?: string }>(
          c,
          'POST',
          `/payments/${encodeURIComponent(paymentId)}/refund`,
          { amount: input.amountPaise, speed: 'normal' },
          { 'X-Refund-Idempotency': input.key.slice(0, 80) },
        );
        return { id: res?.id ?? 'unknown' };
      } catch (err) {
        // Refunding something that is already fully refunded is the outcome we wanted.
        if (
          err instanceof GatewayError &&
          /(has been|already) (been )?(fully )?refunded|refunded already/i.test(err.message)
        ) {
          return { id: 'already-refunded' };
        }
        throw err;
      }
    },

    verifySignature(c, { orderId, paymentId, signature }) {
      const expected = createHmac('sha256', c.keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');
      const given = Buffer.from(signature, 'utf8');
      const wanted = Buffer.from(expected, 'utf8');
      return given.length === wanted.length && timingSafeEqual(given, wanted);
    },
  };
}
