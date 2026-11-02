import { createHmac, randomBytes } from 'node:crypto';
import {
  GatewayError,
  type GatewayCredentials,
  type GatewayPayment,
  type PaymentGateway,
} from '../src/platform/payments/index.js';

/** The keys the fake accepts. */
export const GOOD_KEYS = {
  keyId: 'rzp_test_FakeKey123456',
  keySecret: 'fake-secret-for-tests-1234',
};

interface FakeOrder {
  id: string;
  amountPaise: number;
  currency: string;
  receipt: string;
  payments: GatewayPayment[];
}

/**
 * A stand-in for Razorpay that behaves like the real thing where it matters: it only accepts the
 * right keys, keeps orders and payments, signs successful payments with the shop's secret, and
 * refuses to refund the same payment twice. Tests drive it with `pay`, `down` and `refundError`.
 */
export function createFakeGateway() {
  const orders = new Map<string, FakeOrder>();
  const refunds: { paymentId: string; amountPaise: number; key: string }[] = [];
  const state = {
    down: false,
    refundError: null as GatewayError | null,
    captureMode: 'captured' as 'captured' | 'authorized',
  };

  const need = (c: GatewayCredentials) => {
    if (state.down)
      throw new GatewayError('Could not reach the payment provider', { retryable: true });
    if (c.keyId !== GOOD_KEYS.keyId || c.keySecret !== GOOD_KEYS.keySecret) {
      throw new GatewayError('Authentication failed', { status: 401, retryable: false });
    }
  };
  const sign = (orderId: string, paymentId: string, secret = GOOD_KEYS.keySecret) =>
    createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  const gateway: PaymentGateway = {
    async checkCredentials(c) {
      need(c);
      return { mode: 'test' };
    },
    async createOrder(c, input) {
      need(c);
      const id = `order_${randomBytes(6).toString('hex')}`;
      orders.set(id, { id, ...input, payments: [] });
      return { id };
    },
    async listOrderPayments(c, orderId) {
      need(c);
      return orders.get(orderId)?.payments ?? [];
    },
    async capture(c, payment) {
      need(c);
      for (const o of orders.values()) {
        const p = o.payments.find((x) => x.id === payment.id);
        if (p) p.status = 'captured';
      }
    },
    async refund(c, paymentId, input) {
      need(c);
      if (state.refundError) throw state.refundError;
      for (const o of orders.values()) {
        const p = o.payments.find((x) => x.id === paymentId);
        if (p) {
          if (p.status === 'refunded') return { id: 'already-refunded' };
          p.status = 'refunded';
        }
      }
      refunds.push({ paymentId, amountPaise: input.amountPaise, key: input.key });
      return { id: `rfnd_${refunds.length}` };
    },
    verifySignature(c, { orderId, paymentId, signature }) {
      return sign(orderId, paymentId, c.keySecret) === signature;
    },
  };

  return {
    gateway,
    refunds,
    state,
    orders,
    /** The student pays in the payment window: the gateway now holds a payment and hands back a signature. */
    pay(gatewayOrderId: string, method = 'upi') {
      const order = orders.get(gatewayOrderId);
      if (!order) throw new Error(`no such gateway order ${gatewayOrderId}`);
      const payment: GatewayPayment = {
        id: `pay_${randomBytes(6).toString('hex')}`,
        orderId: order.id,
        status: state.captureMode,
        method,
        amountPaise: order.amountPaise,
      };
      order.payments.push(payment);
      return {
        gatewayOrderId: order.id,
        gatewayPaymentId: payment.id,
        signature: sign(order.id, payment.id),
      };
    },
    /** What the payment window would return, but signed with the wrong secret. */
    forged(gatewayOrderId: string, gatewayPaymentId = 'pay_forged') {
      return {
        gatewayOrderId,
        gatewayPaymentId,
        signature: sign(gatewayOrderId, gatewayPaymentId, 'not-the-secret'),
      };
    },
  };
}

export type FakeGateway = ReturnType<typeof createFakeGateway>;
