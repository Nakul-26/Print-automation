import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createRazorpayGateway,
  createSecretBox,
  GatewayError,
  isRazorpayKeyId,
} from '../src/platform/payments/index.js';

const CREDS = { keyId: 'rzp_test_AbCdEf123456', keySecret: 'super-secret-value' };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for Razorpay's servers: records what was sent and answers from a script. */
function fakeServer(answer: (call: Call) => { status?: number; json?: unknown } | 'network-error') {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const result = answer(call);
    if (result === 'network-error') throw new Error('down');
    return new Response(JSON.stringify(result.json ?? {}), { status: result.status ?? 200 });
  }) as unknown as typeof fetch;
  return {
    calls,
    gateway: createRazorpayGateway({ fetch: fetchImpl, baseUrl: 'https://rzp.test/v1' }),
  };
}

describe('Razorpay gateway', () => {
  it('creates an order in paise with the shop’s own keys', async () => {
    const { calls, gateway } = fakeServer(() => ({ json: { id: 'order_123' } }));
    const order = await gateway.createOrder(CREDS, {
      amountPaise: 4550,
      currency: 'INR',
      receipt: 'P007-abcdefghijklmnopqrstuvwxyz0123456789-too-long',
    });
    expect(order).toEqual({ id: 'order_123' });
    expect(calls[0]).toMatchObject({ url: 'https://rzp.test/v1/orders', method: 'POST' });
    expect(calls[0]!.body).toMatchObject({ amount: 4550, currency: 'INR' });
    expect((calls[0]!.body as { receipt: string }).receipt.length).toBeLessThanOrEqual(40);
    const expectedAuth = Buffer.from(`${CREDS.keyId}:${CREDS.keySecret}`).toString('base64');
    expect(calls[0]!.headers['Authorization']).toBe(`Basic ${expectedAuth}`);
  });

  it('verifies the return signature and rejects anything else', () => {
    const { gateway } = fakeServer(() => ({}));
    const good = createHmac('sha256', CREDS.keySecret).update('order_1|pay_1').digest('hex');
    expect(
      gateway.verifySignature(CREDS, { orderId: 'order_1', paymentId: 'pay_1', signature: good }),
    ).toBe(true);
    // wrong payment, wrong order, truncated, empty, signed with another secret
    expect(
      gateway.verifySignature(CREDS, { orderId: 'order_1', paymentId: 'pay_2', signature: good }),
    ).toBe(false);
    expect(
      gateway.verifySignature(CREDS, { orderId: 'order_2', paymentId: 'pay_1', signature: good }),
    ).toBe(false);
    expect(
      gateway.verifySignature(CREDS, {
        orderId: 'order_1',
        paymentId: 'pay_1',
        signature: good.slice(0, 20),
      }),
    ).toBe(false);
    expect(
      gateway.verifySignature(CREDS, { orderId: 'order_1', paymentId: 'pay_1', signature: '' }),
    ).toBe(false);
    const forged = createHmac('sha256', 'someone-elses-secret')
      .update('order_1|pay_1')
      .digest('hex');
    expect(
      gateway.verifySignature(CREDS, { orderId: 'order_1', paymentId: 'pay_1', signature: forged }),
    ).toBe(false);
  });

  it('lists the payments of an order', async () => {
    const { calls, gateway } = fakeServer(() => ({
      json: {
        items: [
          { id: 'pay_a', order_id: 'order_1', status: 'failed', method: 'card', amount: 1000 },
          { id: 'pay_b', order_id: 'order_1', status: 'captured', method: 'upi', amount: 1000 },
        ],
      },
    }));
    const payments = await gateway.listOrderPayments(CREDS, 'order_1');
    expect(calls[0]!.url).toBe('https://rzp.test/v1/orders/order_1/payments');
    expect(payments).toEqual([
      { id: 'pay_a', orderId: 'order_1', status: 'failed', method: 'card', amountPaise: 1000 },
      { id: 'pay_b', orderId: 'order_1', status: 'captured', method: 'upi', amountPaise: 1000 },
    ]);
  });

  it('refunds the full amount once, treating "already refunded" as done', async () => {
    const { calls, gateway } = fakeServer(() => ({ json: { id: 'rfnd_1' } }));
    expect(
      await gateway.refund(CREDS, 'pay_b', { amountPaise: 1000, key: 'refund-order-1' }),
    ).toEqual({ id: 'rfnd_1' });
    expect(calls[0]).toMatchObject({
      url: 'https://rzp.test/v1/payments/pay_b/refund',
      method: 'POST',
    });
    expect(calls[0]!.body).toMatchObject({ amount: 1000 });
    expect(calls[0]!.headers['X-Refund-Idempotency']).toBe('refund-order-1');

    const again = fakeServer(() => ({
      status: 400,
      json: {
        error: {
          description: 'The payment has been fully refunded already',
          code: 'BAD_REQUEST_ERROR',
        },
      },
    }));
    expect(await again.gateway.refund(CREDS, 'pay_b', { amountPaise: 1000, key: 'k' })).toEqual({
      id: 'already-refunded',
    });
  });

  it('explains bad keys plainly and marks outages as worth retrying', async () => {
    const bad = fakeServer(() => ({
      status: 401,
      json: { error: { description: 'Authentication failed', code: 'BAD_REQUEST_ERROR' } },
    }));
    await expect(bad.gateway.checkCredentials(CREDS)).rejects.toMatchObject({
      message: 'Authentication failed',
      info: { status: 401, retryable: false },
    });

    const down = fakeServer(() => ({ status: 503 }));
    await expect(
      down.gateway.createOrder(CREDS, { amountPaise: 100, currency: 'INR', receipt: 'r' }),
    ).rejects.toMatchObject({
      info: { retryable: true },
    });

    const offline = fakeServer(() => 'network-error');
    const err = await offline.gateway.listOrderPayments(CREDS, 'o').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.info.retryable).toBe(true);
  });

  it('reports test or live mode from the key and refuses keys that are not Razorpay keys', async () => {
    const { gateway } = fakeServer(() => ({ json: { items: [] } }));
    expect(await gateway.checkCredentials(CREDS)).toEqual({ mode: 'test' });
    expect(
      await gateway.checkCredentials({ keyId: 'rzp_live_ZyXwVu987654', keySecret: 'x' }),
    ).toEqual({ mode: 'live' });
    await expect(gateway.checkCredentials({ keyId: 'not-a-key', keySecret: 'x' })).rejects.toThrow(
      /Key ID/,
    );
    expect(isRazorpayKeyId('rzp_test_AbCdEf123456')).toBe(true);
    expect(isRazorpayKeyId('rzp_test_')).toBe(false);
  });
});

describe('secret box', () => {
  it('round-trips a secret and never stores it readable', () => {
    const box = createSecretBox('a-server-secret-of-some-length-1234567890');
    const sealed = box.seal('my-razorpay-secret');
    expect(sealed).not.toContain('my-razorpay-secret');
    expect(box.open(sealed)).toBe('my-razorpay-secret');
    // two seals of the same text differ (fresh random IV)
    expect(box.seal('my-razorpay-secret')).not.toBe(sealed);
  });

  it('refuses tampered values and values sealed under another server secret', () => {
    const box = createSecretBox('a-server-secret-of-some-length-1234567890');
    const other = createSecretBox('a-different-server-secret-of-some-length-0');
    const sealed = box.seal('s3cret');
    expect(other.open(sealed)).toBeNull();
    const [v, iv, tag, body] = sealed.split('.');
    expect(box.open([v, iv, tag, body!.slice(0, -2) + 'AA'].join('.'))).toBeNull();
    expect(box.open('garbage')).toBeNull();
    expect(box.open('')).toBeNull();
  });
});
