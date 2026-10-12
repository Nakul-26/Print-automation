import {
  AdminAuditList,
  AdminSettings,
  AdminShop,
  AdminShopList,
  ApplyConfig,
  ApplyResponse,
  RatesBody,
  type ApplyRequest,
  type ShopLimitsBody,
} from '@print/contracts';
import { request } from './api';

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Shop sign-up (public). */
export const applyApi = {
  config: () => request(ApplyConfig, '/applications/config'),
  apply: (body: ApplyRequest) => request(ApplyResponse, '/applications', json('POST', body)),
};

/** Platform-admin calls. The server refuses anyone who is not a platform admin. */
export const adminApi = {
  shops: async () => (await request(AdminShopList, '/admin/shops')).shops,
  approve: (id: string) => request(AdminShop, `/admin/shops/${id}/approve`, json('POST')),
  suspend: (id: string, reason: string) =>
    request(AdminShop, `/admin/shops/${id}/suspend`, json('POST', { reason })),
  reactivate: (id: string) => request(AdminShop, `/admin/shops/${id}/reactivate`, json('POST')),
  setLimits: (id: string, body: ShopLimitsBody) =>
    request(AdminShop, `/admin/shops/${id}`, json('PATCH', body)),
  settings: () => request(AdminSettings, '/admin/settings'),
  setStorageMax: (storageMaxBytes: number) =>
    request(AdminSettings, '/admin/settings', json('PUT', { storageMaxBytes })),
  audit: async (shopId?: string) =>
    (await request(AdminAuditList, `/admin/audit?limit=30${shopId ? `&shopId=${shopId}` : ''}`))
      .entries,
};

/** The owner's own price list. */
export const ratesApi = {
  get: (shopId: string) => request(RatesBody, `/owner/shops/${shopId}/rates`),
  save: (shopId: string, body: RatesBody) =>
    request(RatesBody, `/owner/shops/${shopId}/rates`, json('PUT', body)),
};
