import {
  MeResponse,
  PairingCode,
  PrintingStatus,
  OwnerOrder,
  OwnerQueueResponse,
  OwnerSummary,
  AddStaffResponse,
  PaymentSettingsView,
  ResetStaffPasswordResponse,
  StaffListResponse,
  type AddStaffBody,
  type SavePaymentKeysBody,
  ShopDetail,
  ShopListResponse,
  type OrderActionBody,
  type PrinterMappingBody,
} from '@print/contracts';
import { z } from 'zod';
import { ApiError, readError, request } from './api';

const BASE = '/api/v1';

/** Calls the shop-owner side of the API. Sign-in is a cookie, so nothing is stored in the page. */
export const ownerApi = {
  me: () => request(MeResponse, '/auth/me'),

  login: (email: string, password: string) =>
    request(MeResponse, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: async (): Promise<void> => {
    await fetch(`${BASE}/auth/logout`, { method: 'POST' }).catch(() => undefined);
  },

  shops: () => request(ShopListResponse, '/owner/shops'),

  shop: (shopId: string) => request(ShopDetail, `/owner/shops/${shopId}`),

  queue: async (shopId: string) =>
    (await request(OwnerQueueResponse, `/owner/shops/${shopId}/orders`)).orders,

  summary: (shopId: string) => request(OwnerSummary, `/owner/shops/${shopId}/summary`),

  act: (shopId: string, orderId: string, body: OrderActionBody) =>
    request(OwnerOrder, `/owner/shops/${shopId}/orders/${orderId}/actions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  printing: (shopId: string) => request(PrintingStatus, `/owner/shops/${shopId}/printing`),

  createPairingCode: (shopId: string) =>
    request(PairingCode, `/owner/shops/${shopId}/printing/pairing`, { method: 'POST' }),

  saveMapping: (shopId: string, body: PrinterMappingBody) =>
    request(PrintingStatus, `/owner/shops/${shopId}/printing/mapping`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  sendTestPages: (shopId: string) =>
    request(z.object({ sent: z.number() }), `/owner/shops/${shopId}/printing/test`, {
      method: 'POST',
    }),

  removePrintingApp: async (shopId: string, deviceId: string): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/owner/shops/${shopId}/printing/agents/${deviceId}`, {
        method: 'DELETE',
      });
    } catch {
      throw new ApiError(0, 'network', 'No connection. Check your internet and try again.');
    }
    if (!res.ok) throw await readError(res);
  },

  fileUrl: (shopId: string, orderId: string, itemId: string, download = false) =>
    `${BASE}/owner/shops/${shopId}/orders/${orderId}/items/${itemId}/file${download ? '?download=1' : ''}`,
};

export const isUnauthenticated = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;

/** The owner's staff list: who can sign in to the shop's queue. */
export const staffApi = {
  list: async (shopId: string) =>
    (await request(StaffListResponse, `/owner/shops/${shopId}/staff`)).members,

  add: (shopId: string, body: AddStaffBody) =>
    request(AddStaffResponse, `/owner/shops/${shopId}/staff`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resetPassword: async (shopId: string, userId: string) =>
    (
      await request(
        ResetStaffPasswordResponse,
        `/owner/shops/${shopId}/staff/${userId}/reset-password`,
        { method: 'POST' },
      )
    ).password,

  remove: async (shopId: string, userId: string): Promise<void> => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/owner/shops/${shopId}/staff/${userId}`, { method: 'DELETE' });
    } catch {
      throw new ApiError(0, 'network', 'No connection. Check your internet and try again.');
    }
    if (!res.ok) throw await readError(res);
  },
};

/** The owner's online payment set-up: their own Razorpay keys. The secret is never sent back. */
export const paymentsApi = {
  get: (shopId: string) => request(PaymentSettingsView, `/owner/shops/${shopId}/payments`),

  saveKeys: (shopId: string, body: SavePaymentKeysBody) =>
    request(PaymentSettingsView, `/owner/shops/${shopId}/payments/keys`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  setEnabled: (shopId: string, enabled: boolean) =>
    request(PaymentSettingsView, `/owner/shops/${shopId}/payments/enabled`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  remove: (shopId: string) =>
    request(PaymentSettingsView, `/owner/shops/${shopId}/payments/keys`, { method: 'DELETE' }),
};
