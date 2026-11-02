import type {
  CheckoutPayload,
  ConfirmPaymentBody,
  PaymentSettingsView,
  PaymentStatusResponse,
  SavePaymentKeysBody,
} from '@print/contracts';
import { HttpError } from '../../../platform/http/error-handler.js';
import type { Logger } from '../../../platform/observability/logger.js';
import type { JobQueue } from '../../../platform/queue/index.js';
import {
  GatewayError,
  type GatewayCredentials,
  type GatewayPayment,
  type PaymentGateway,
  type SecretBox,
} from '../../../platform/payments/index.js';
import type { Audit } from '../../audit/index.js';
import type { PaymentRecord, PaymentRepo } from '../repo/payment-repo.js';

export const REFUND_JOB = 'payments.refund';

/** What payments needs to know and change about an order (wired in the composition root). */
export interface OrdersPort {
  contextByToken(token: string): Promise<OrderContext | null>;
  contextById(orderId: string): Promise<OrderContext | null>;
  markPaid(
    orderId: string,
    paid: { method: string | null; amountPaise: number; at: Date },
  ): Promise<boolean>;
  switchToCounter(orderId: string): Promise<boolean>;
  expireUnpaid(orderId: string): Promise<boolean>;
  recordRefund(orderId: string, outcome: 'refunded' | 'refund_failed'): Promise<boolean>;
}

export interface OrderContext {
  orderId: string;
  shopId: string;
  queueNumber: number;
  status: string;
  paymentState: string;
  amountPaise: number;
  currency: string;
  customerName: string | null;
  createdAt: Date;
}

const PROVIDER = 'razorpay';
/** A student who has not paid this long after starting is treated as having left. */
const PAYMENT_WINDOW_MINUTES = 20;
/** Give up retrying a refund after this long and tell the shop to do it by hand. */
const REFUND_GIVE_UP_HOURS = 6;
const BATCH = 100;

export function createPaymentService(deps: {
  repo: PaymentRepo;
  gateway: PaymentGateway;
  box: SecretBox;
  audit: Audit;
  logger: Logger;
  queue: JobQueue;
  /** Resolved lazily: orders is built after payments. */
  orders: () => OrdersPort;
  findShopName: (shopId: string) => Promise<string | null>;
  now?: () => Date;
}) {
  const { repo, gateway, box, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const orders = () => deps.orders();

  const modeOf = (keyId: string): 'test' | 'live' =>
    keyId.startsWith('rzp_live_') ? 'live' : 'test';

  /** The shop's keys, decrypted. Null when there are none or they can no longer be read. */
  async function credentialsFor(
    shopId: string,
  ): Promise<{ creds: GatewayCredentials; enabled: boolean } | null> {
    const settings = await repo.getSettings(shopId);
    if (!settings) return null;
    const keySecret = box.open(settings.keySecretEnc);
    if (!keySecret) {
      logger.error({ shopId }, 'stored payment keys could not be decrypted');
      return null;
    }
    return { creds: { keyId: settings.keyId, keySecret }, enabled: settings.enabled };
  }

  function checkoutOf(
    payment: PaymentRecord,
    creds: GatewayCredentials,
    ctx: OrderContext,
    shopName: string,
  ): CheckoutPayload {
    return {
      keyId: creds.keyId,
      gatewayOrderId: payment.providerOrderId,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      shopName,
      prefillName: ctx.customerName,
      testMode: modeOf(creds.keyId) === 'test',
    };
  }

  /** The amount and method the student paid, for the order page. */
  function viewOf(
    payment: PaymentRecord | null,
    ctx: OrderContext,
  ): PaymentStatusResponse['payment'] {
    return {
      state: ctx.paymentState as PaymentStatusResponse['payment']['state'],
      amountPaise: payment?.amountPaise ?? ctx.amountPaise,
      method: payment?.method ?? null,
    };
  }

  /** Looks at what the gateway says about this payment, and settles it if the money is in. */
  async function settle(
    payment: PaymentRecord,
    creds: GatewayCredentials,
    paymentId: string,
    known?: GatewayPayment,
  ): Promise<boolean> {
    let found = known;
    if (!found) {
      try {
        found = (await gateway.listOrderPayments(creds, payment.providerOrderId)).find(
          (p) => p.id === paymentId,
        );
      } catch (err) {
        // The signature already proved the payment. The method is a nicety; do not lose the order over it.
        logger.warn({ err, orderId: payment.orderId }, 'could not read the payment details');
      }
    }
    if (found) {
      if (found.status === 'failed') return false;
      if (found.amountPaise !== payment.amountPaise) {
        logger.error(
          { orderId: payment.orderId, paid: found.amountPaise, expected: payment.amountPaise },
          'paid amount does not match the order',
        );
        return false;
      }
      if (found.status === 'authorized') {
        await gateway
          .capture(creds, {
            id: found.id,
            amountPaise: payment.amountPaise,
            currency: payment.currency,
          })
          .catch((err) => logger.warn({ err, orderId: payment.orderId }, 'capture failed'));
      }
    }
    const at = now();
    const method = found?.method ?? null;
    const won = await repo.transition(payment.id, ['awaiting'], {
      status: 'paid',
      providerPaymentId: paymentId,
      method,
      paidAt: at,
    });
    if (!won) return true; // someone else already settled it
    await orders().markPaid(payment.orderId, { method, amountPaise: payment.amountPaise, at });
    await audit.record({
      actorType: 'anonymous',
      shopId: payment.shopId,
      action: 'payment.paid',
      entity: 'order',
      entityId: payment.orderId,
      metadata: { method, amountPaise: payment.amountPaise },
    });
    return true;
  }

  /** Asks the gateway about one waiting payment: settles it, or gives up on it after a while. */
  async function reconcileOne(payment: PaymentRecord): Promise<void> {
    if (payment.status !== 'awaiting') return;
    const keys = await credentialsFor(payment.shopId);
    if (keys) {
      try {
        const payments = await gateway.listOrderPayments(keys.creds, payment.providerOrderId);
        const paid = payments.find(
          (p) =>
            (p.status === 'captured' || p.status === 'authorized') &&
            p.amountPaise === payment.amountPaise,
        );
        if (paid && (await settle(payment, keys.creds, paid.id, paid))) return;
      } catch (err) {
        logger.warn({ err, orderId: payment.orderId }, 'could not check a waiting payment');
        return; // try again on the next round; never give up while the gateway cannot be reached
      }
    }
    const ageMinutes = (now().getTime() - payment.createdAt.getTime()) / 60_000;
    if (ageMinutes < PAYMENT_WINDOW_MINUTES) return;
    const gaveUp = await repo.transition(payment.id, ['awaiting'], { status: 'abandoned' });
    if (gaveUp) await orders().expireUnpaid(payment.orderId);
  }

  /**
   * A payment that arrives after the order was closed (the student paid at minute 21) is never kept:
   * it is found and sent straight back.
   */
  async function refundLatePayment(
    payment: PaymentRecord,
    creds: GatewayCredentials,
    knownPaymentId?: string,
  ): Promise<boolean> {
    const payments = await gateway.listOrderPayments(creds, payment.providerOrderId);
    const late = payments.find(
      (p) =>
        (knownPaymentId ? p.id === knownPaymentId : true) &&
        (p.status === 'captured' || p.status === 'authorized') &&
        p.amountPaise === payment.amountPaise,
    );
    if (!late) return false;
    if (late.status === 'authorized') {
      await gateway
        .capture(creds, {
          id: late.id,
          amountPaise: payment.amountPaise,
          currency: payment.currency,
        })
        .catch((err) => logger.warn({ err, orderId: payment.orderId }, 'capture failed'));
    }
    const moved = await repo.transition(payment.id, ['abandoned'], {
      status: 'refund_pending',
      providerPaymentId: late.id,
      method: late.method,
      paidAt: now(),
    });
    if (!moved) return true;
    await deps.queue.enqueue(REFUND_JOB, { orderId: payment.orderId });
    await audit.record({
      actorType: 'system',
      shopId: payment.shopId,
      action: 'payment.late_refund',
      entity: 'order',
      entityId: payment.orderId,
      metadata: { amountPaise: payment.amountPaise },
    });
    return true;
  }

  async function paymentByToken(token: string) {
    const ctx = await orders().contextByToken(token);
    if (!ctx) throw new HttpError(404, 'Order not found', 'not_found');
    return { ctx, payment: await repo.findByOrderId(ctx.orderId) };
  }

  async function statusFor(
    ctx: OrderContext,
    payment: PaymentRecord | null,
  ): Promise<PaymentStatusResponse> {
    let checkout: CheckoutPayload | null = null;
    if (payment?.status === 'awaiting' && ctx.paymentState === 'awaiting') {
      const keys = await credentialsFor(payment.shopId);
      const shopName = (await deps.findShopName(payment.shopId)) ?? '';
      if (keys) checkout = checkoutOf(payment, keys.creds, ctx, shopName);
    }
    return { payment: viewOf(payment, ctx), checkout };
  }

  /** Moves a paid payment into refunding and starts the refund. Safe to call twice. */
  async function requestRefund(orderId: string): Promise<void> {
    const payment = await repo.findByOrderId(orderId);
    if (!payment || payment.status !== 'paid') return;
    const moved = await repo.transition(payment.id, ['paid'], { status: 'refund_pending' });
    if (!moved) return;
    await deps.queue.enqueue(REFUND_JOB, { orderId });
  }

  async function processRefund(orderId: string): Promise<void> {
    const payment = await repo.findByOrderId(orderId);
    if (!payment || payment.status !== 'refund_pending' || !payment.providerPaymentId) return;
    const keys = await credentialsFor(payment.shopId);

    const fail = async (reason: string) => {
      const moved = await repo.transition(payment.id, ['refund_pending'], {
        status: 'refund_failed',
        error: reason.slice(0, 300),
      });
      if (!moved) return;
      await orders().recordRefund(orderId, 'refund_failed');
      await audit.record({
        actorType: 'system',
        shopId: payment.shopId,
        action: 'payment.refund_failed',
        entity: 'order',
        entityId: orderId,
        metadata: { reason: reason.slice(0, 200) },
      });
    };

    if (!keys) return fail('The shop’s payment keys are missing, so the refund could not be sent.');
    try {
      const refund = await gateway.refund(keys.creds, payment.providerPaymentId, {
        amountPaise: payment.amountPaise,
        key: `refund-${payment.id}`,
      });
      const moved = await repo.transition(payment.id, ['refund_pending'], {
        status: 'refunded',
        refundId: refund.id,
        refundedAt: now(),
      });
      if (!moved) return;
      await orders().recordRefund(orderId, 'refunded');
      await audit.record({
        actorType: 'system',
        shopId: payment.shopId,
        action: 'payment.refunded',
        entity: 'order',
        entityId: orderId,
        metadata: { amountPaise: payment.amountPaise },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'The refund failed';
      const retryable = err instanceof GatewayError ? err.info.retryable : true;
      const hours = (now().getTime() - payment.updatedAt.getTime()) / 3_600_000;
      if (!retryable || hours >= REFUND_GIVE_UP_HOURS) return fail(reason);
      logger.warn({ err, orderId }, 'refund will be retried');
    }
  }

  return {
    // ================================================================ the shop's settings
    async settingsView(shopId: string): Promise<PaymentSettingsView> {
      const settings = await repo.getSettings(shopId);
      return {
        configured: settings !== null,
        enabled: settings?.enabled ?? false,
        keyId: settings?.keyId ?? null,
        mode: settings ? modeOf(settings.keyId) : null,
      };
    },

    /** Saves a shop's own gateway keys after proving they work. The secret is stored encrypted. */
    async saveKeys(
      shopId: string,
      actorId: string,
      body: SavePaymentKeysBody,
    ): Promise<PaymentSettingsView> {
      const existing = await repo.getSettings(shopId);
      if (existing && existing.keyId !== body.keyId && (await repo.countInFlight(shopId)) > 0) {
        throw new HttpError(
          409,
          'Some payments are still in progress. Try changing the keys again in a few minutes.',
          'payments_in_progress',
        );
      }
      try {
        await gateway.checkCredentials({ keyId: body.keyId, keySecret: body.keySecret });
      } catch (err) {
        if (err instanceof GatewayError && !err.info.retryable) {
          throw new HttpError(
            400,
            err.info.status === 401
              ? 'Razorpay did not accept these keys. Check that the Key ID and Key Secret belong together.'
              : err.message,
            'invalid_payment_keys',
          );
        }
        throw new HttpError(
          502,
          'Could not reach Razorpay to check the keys. Try again in a moment.',
          'payment_provider_unavailable',
        );
      }
      await repo.upsertSettings({
        shopId,
        provider: PROVIDER,
        keyId: body.keyId,
        keySecretEnc: box.seal(body.keySecret),
        enabled: body.enabled ?? existing?.enabled ?? false,
      });
      await audit.record({
        actorType: 'user',
        actorId,
        shopId,
        action: 'payments.keys_saved',
        metadata: { mode: modeOf(body.keyId) },
      });
      return this.settingsView(shopId);
    },

    async setEnabled(
      shopId: string,
      actorId: string,
      enabled: boolean,
    ): Promise<PaymentSettingsView> {
      if (!(await repo.setEnabled(shopId, enabled))) {
        throw new HttpError(409, 'Add your Razorpay keys first.', 'no_payment_keys');
      }
      await audit.record({
        actorType: 'user',
        actorId,
        shopId,
        action: enabled ? 'payments.enabled' : 'payments.disabled',
      });
      return this.settingsView(shopId);
    },

    async removeKeys(shopId: string, actorId: string): Promise<PaymentSettingsView> {
      if ((await repo.countInFlight(shopId)) > 0) {
        throw new HttpError(
          409,
          'Some payments are still in progress. Try again in a few minutes.',
          'payments_in_progress',
        );
      }
      await repo.deleteSettings(shopId);
      await audit.record({ actorType: 'user', actorId, shopId, action: 'payments.keys_removed' });
      return this.settingsView(shopId);
    },

    /** For the platform admin: which shops take online payment, and in which mode. */
    async overviewByShop(): Promise<Map<string, { enabled: boolean; mode: 'test' | 'live' }>> {
      return new Map(
        (await repo.allSettings()).map((s) => [
          s.shopId,
          { enabled: s.enabled, mode: modeOf(s.keyId) },
        ]),
      );
    },

    // ================================================================ used while placing an order
    async isEnabled(shopId: string): Promise<boolean> {
      const keys = await credentialsFor(shopId);
      return keys?.enabled === true;
    },

    async prepare(input: {
      shopId: string;
      shopName: string;
      amountPaise: number;
      currency: string;
      receipt: string;
      prefillName: string | null;
    }): Promise<CheckoutPayload> {
      const keys = await credentialsFor(input.shopId);
      if (!keys?.enabled) {
        throw new HttpError(
          409,
          'Online payment is not available for this shop. Choose to pay at the counter.',
          'online_payment_unavailable',
        );
      }
      try {
        const order = await gateway.createOrder(keys.creds, {
          amountPaise: input.amountPaise,
          currency: input.currency,
          receipt: input.receipt,
        });
        return {
          keyId: keys.creds.keyId,
          gatewayOrderId: order.id,
          amountPaise: input.amountPaise,
          currency: input.currency,
          shopName: input.shopName,
          prefillName: input.prefillName,
          testMode: modeOf(keys.creds.keyId) === 'test',
        };
      } catch (err) {
        logger.error({ err, shopId: input.shopId }, 'could not open an online payment');
        throw new HttpError(
          502,
          'Online payment is not available right now. You can pay at the counter instead.',
          'payment_provider_unavailable',
        );
      }
    },

    async attach(input: {
      orderId: string;
      shopId: string;
      checkout: CheckoutPayload;
    }): Promise<void> {
      await repo.createPayment({
        orderId: input.orderId,
        shopId: input.shopId,
        provider: PROVIDER,
        providerOrderId: input.checkout.gatewayOrderId,
        amountPaise: input.checkout.amountPaise,
        currency: input.checkout.currency,
      });
    },

    // ================================================================ the student's side
    async status(token: string): Promise<PaymentStatusResponse> {
      const { ctx, payment } = await paymentByToken(token);
      return statusFor(ctx, payment);
    },

    /** The payment window said it worked. Only the gateway's signature is believed, never the browser's word. */
    async confirm(token: string, body: ConfirmPaymentBody): Promise<PaymentStatusResponse> {
      const { ctx, payment } = await paymentByToken(token);
      if (!payment) throw new HttpError(404, 'No online payment for this order', 'not_found');
      if (payment.status === 'abandoned') {
        const keys = await credentialsFor(payment.shopId);
        if (
          keys &&
          gateway.verifySignature(keys.creds, {
            orderId: body.gatewayOrderId,
            paymentId: body.gatewayPaymentId,
            signature: body.signature,
          }) &&
          body.gatewayOrderId === payment.providerOrderId
        ) {
          await refundLatePayment(payment, keys.creds, body.gatewayPaymentId).catch((err) =>
            logger.error({ err, orderId: payment.orderId }, 'could not start the late refund'),
          );
          throw new HttpError(
            409,
            'This order was cancelled because the payment took too long. Your money will be refunded.',
            'payment_expired',
          );
        }
      }
      if (payment.status === 'awaiting') {
        if (body.gatewayOrderId !== payment.providerOrderId) {
          throw new HttpError(
            400,
            'That payment belongs to a different order.',
            'payment_mismatch',
          );
        }
        const keys = await credentialsFor(payment.shopId);
        if (!keys) {
          throw new HttpError(
            409,
            'Online payment is not available for this shop.',
            'online_payment_unavailable',
          );
        }
        const genuine = gateway.verifySignature(keys.creds, {
          orderId: body.gatewayOrderId,
          paymentId: body.gatewayPaymentId,
          signature: body.signature,
        });
        if (!genuine) {
          await audit.record({
            actorType: 'anonymous',
            shopId: payment.shopId,
            action: 'payment.bad_signature',
            entity: 'order',
            entityId: payment.orderId,
          });
          throw new HttpError(
            400,
            'We could not verify this payment.',
            'payment_signature_invalid',
          );
        }
        if (!(await settle(payment, keys.creds, body.gatewayPaymentId))) {
          throw new HttpError(
            409,
            'The payment did not go through. Please try again.',
            'payment_not_completed',
          );
        }
      }
      const fresh = await orders().contextById(ctx.orderId);
      return statusFor(fresh ?? ctx, await repo.findByOrderId(ctx.orderId));
    },

    /** Checks with the gateway right now (the student's page does this when it comes back to the order). */
    async refresh(token: string): Promise<PaymentStatusResponse> {
      const { ctx, payment } = await paymentByToken(token);
      if (payment) await reconcileOne(payment);
      const fresh = (await orders().contextById(ctx.orderId)) ?? ctx;
      return statusFor(fresh, await repo.findByOrderId(ctx.orderId));
    },

    /** The student decides to pay at the counter after all, unless the money has already arrived. */
    async switchToCounter(token: string): Promise<PaymentStatusResponse> {
      const { ctx, payment } = await paymentByToken(token);
      if (payment?.status === 'awaiting') {
        await reconcileOne(payment); // never drop a payment that has just gone through
        const current = await repo.findByOrderId(ctx.orderId);
        if (current?.status === 'awaiting') {
          const moved = await repo.transition(current.id, ['awaiting'], { status: 'abandoned' });
          if (moved) await orders().switchToCounter(ctx.orderId);
        } else if (current?.status === 'abandoned') {
          // the background check gave up on it just now: nothing more to do
        }
      }
      const fresh = (await orders().contextById(ctx.orderId)) ?? ctx;
      return statusFor(fresh, await repo.findByOrderId(ctx.orderId));
    },

    // ================================================================ background work
    requestRefund,
    processRefund,

    /** Runs every minute: settles payments the browser never confirmed, retries refunds, gives up on the rest. */
    async sweep(): Promise<{ waiting: number; refunds: number }> {
      const waiting = await repo.listByStatus('awaiting', BATCH);
      for (const payment of waiting) {
        await reconcileOne(payment).catch((err) =>
          logger.error({ err, orderId: payment.orderId }, 'payment check failed'),
        );
      }
      // Payers who turned up after we gave up on them are found and refunded.
      const since = new Date(now().getTime() - 2 * 3_600_000);
      for (const payment of await repo.listAbandonedSince(since, BATCH)) {
        const keys = await credentialsFor(payment.shopId);
        if (!keys) continue;
        await refundLatePayment(payment, keys.creds).catch((err) =>
          logger.warn({ err, orderId: payment.orderId }, 'late payment check failed'),
        );
      }
      const refunds = await repo.listByStatus('refund_pending', BATCH);
      for (const payment of refunds) {
        await processRefund(payment.orderId).catch((err) =>
          logger.error({ err, orderId: payment.orderId }, 'refund retry failed'),
        );
      }
      return { waiting: waiting.length, refunds: refunds.length };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
