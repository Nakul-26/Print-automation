import type { CheckoutPayload, ConfirmPaymentBody } from '@print/contracts';

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { name?: string };
  theme?: { color: string };
  retry?: { enabled: boolean };
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void;
  modal: { ondismiss: () => void; confirm_close?: boolean };
}

interface RazorpayInstance {
  open: () => void;
  on: (
    event: 'payment.failed',
    cb: (response: { error?: { description?: string } }) => void,
  ) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

let loading: Promise<void> | null = null;

/** Loads Razorpay's payment window script once, only when a student actually chooses to pay online. */
function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export type CheckoutResult =
  | { kind: 'paid'; body: ConfirmPaymentBody }
  | { kind: 'closed' }
  | { kind: 'failed'; message: string };

/** Opens the payment window and says how it ended. Nothing is trusted until the server checks the signature. */
export async function openCheckout(
  checkout: CheckoutPayload,
  description: string,
): Promise<CheckoutResult> {
  try {
    await loadScript();
  } catch (err) {
    return {
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Could not open payment.',
    };
  }
  const Razorpay = window.Razorpay;
  if (!Razorpay) return { kind: 'failed', message: 'The payment window is not available.' };

  return new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    const done = (result: CheckoutResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const instance = new Razorpay({
      key: checkout.keyId,
      order_id: checkout.gatewayOrderId,
      amount: checkout.amountPaise,
      currency: checkout.currency,
      name: checkout.shopName,
      description,
      ...(checkout.prefillName ? { prefill: { name: checkout.prefillName } } : {}),
      theme: { color: '#0a6e8a' },
      retry: { enabled: true },
      handler: (r) =>
        done({
          kind: 'paid',
          body: {
            gatewayOrderId: r.razorpay_order_id,
            gatewayPaymentId: r.razorpay_payment_id,
            signature: r.razorpay_signature,
          },
        }),
      modal: { ondismiss: () => done({ kind: 'closed' }) },
    });
    instance.on('payment.failed', () => {
      // The window stays open and lets the student try another method; nothing to do here.
    });
    instance.open();
  });
}
