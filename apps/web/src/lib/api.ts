import type { z } from 'zod';
import {
  CreateOrderResponse,
  CreateUploadResponse,
  EstimateResponse,
  OrderView,
  PublicShopInfo,
  UploadView,
  type CreateOrderRequest,
  type EstimateRequest,
} from '@print/contracts';

const BASE = '/api/v1';

/** An error returned by the API, with the server's plain-language message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(
      res.status,
      body.error?.code ?? 'error',
      body.error?.message ?? 'Something went wrong. Please try again.',
    );
  } catch {
    return new ApiError(res.status, 'error', 'Something went wrong. Please try again.');
  }
}

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init?: RequestInit,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new ApiError(0, 'network', 'No connection. Check your internet and try again.');
  }
  if (!res.ok) throw await readError(res);
  return schema.parse(await res.json());
}

export const api = {
  getShop: (slug: string) => request(PublicShopInfo, `/shops/${encodeURIComponent(slug)}`),

  getUpload: (token: string) => request(UploadView, `/uploads/${token}`),

  changeConversion: (token: string, settings: Record<string, unknown>) =>
    request(UploadView, `/uploads/${token}/conversion`, {
      method: 'POST',
      body: JSON.stringify({ settings }),
    }),

  discardUpload: async (token: string): Promise<void> => {
    await fetch(`${BASE}/uploads/${token}`, { method: 'DELETE' }).catch(() => undefined);
  },

  estimate: (slug: string, body: EstimateRequest) =>
    request(EstimateResponse, `/shops/${encodeURIComponent(slug)}/estimate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  createOrder: (slug: string, body: z.input<typeof CreateOrderRequest>) =>
    request(CreateOrderResponse, `/shops/${encodeURIComponent(slug)}/orders`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getOrder: (token: string) => request(OrderView, `/orders/${token}`),

  previewUrl: (token: string) => `${BASE}/uploads/${token}/preview`,
};

/** Uploads one file, reporting progress (0 to 1). Uses XHR because fetch cannot report upload progress. */
export function uploadFile(
  slug: string,
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<CreateUploadResponse>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<CreateUploadResponse>((resolve, reject) => {
    xhr.open('POST', `${BASE}/shops/${encodeURIComponent(slug)}/uploads`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () =>
      reject(
        new ApiError(
          0,
          'network',
          'The upload was interrupted. Check your internet and try again.',
        ),
      );
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = CreateUploadResponse.safeParse(xhr.response);
        if (parsed.success) resolve(parsed.data);
        else
          reject(new ApiError(xhr.status, 'bad_response', 'Unexpected response from the server.'));
      } else {
        const err = (xhr.response as { error?: { code?: string; message?: string } } | null)?.error;
        reject(
          new ApiError(
            xhr.status,
            err?.code ?? 'error',
            err?.message ?? 'The upload failed. Please try again.',
          ),
        );
      }
    };
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
  return { promise, cancel: () => xhr.abort() };
}
