import {
  MeResponse,
  OwnerOrder,
  OwnerQueueResponse,
  ShopDetail,
  ShopListResponse,
  type OrderActionBody,
} from '@print/contracts';
import { ApiError, request } from './api';

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

  act: (shopId: string, orderId: string, body: OrderActionBody) =>
    request(OwnerOrder, `/owner/shops/${shopId}/orders/${orderId}/actions`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  fileUrl: (shopId: string, orderId: string, itemId: string, download = false) =>
    `${BASE}/owner/shops/${shopId}/orders/${orderId}/items/${itemId}/file${download ? '?download=1' : ''}`,
};

export const isUnauthenticated = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;
