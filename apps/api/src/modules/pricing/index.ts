import { Router, type RequestHandler } from 'express';
import { RatesBody } from '@print/contracts';
import type { RateTable } from '@print/domain';
import type { Db } from '../../platform/db/client.js';
import { HttpError } from '../../platform/http/error-handler.js';
import type { Audit } from '../audit/index.js';
import { createPricingRepo } from './repo/pricing-repo.js';

/** Starting prices for a new shop; the owner edits them in settings. All amounts in paise. */
export const DEFAULT_RATES: RatesBody = {
  minimumChargePaise: 200,
  rates: [
    { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 200 },
    { paperSize: 'A4', colorMode: 'black_white', sides: 'double', pricePerSidePaise: 150 },
    { paperSize: 'A4', colorMode: 'color', sides: 'single', pricePerSidePaise: 1000 },
    { paperSize: 'A4', colorMode: 'color', sides: 'double', pricePerSidePaise: 800 },
    { paperSize: 'A3', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 600 },
    { paperSize: 'A3', colorMode: 'black_white', sides: 'double', pricePerSidePaise: 500 },
    { paperSize: 'A3', colorMode: 'color', sides: 'single', pricePerSidePaise: 2000 },
    { paperSize: 'A3', colorMode: 'color', sides: 'double', pricePerSidePaise: 1600 },
  ],
};

/** Public API of the pricing module: each shop's rate card. */
export function createPricing(deps: {
  db: Db;
  audit: Audit;
  requireAuth: RequestHandler;
  requireShopAccess: RequestHandler;
}) {
  const repo = createPricingRepo(deps.db);

  // Mounted at /api/v1/owner/shops
  const ownerRouter = Router();
  ownerRouter.use(deps.requireAuth);

  ownerRouter.get('/:shopId/rates', deps.requireShopAccess, async (req, res) => {
    const table = await repo.getRateTable(req.tenant!.shopId);
    res.json({ rates: table.rates, minimumChargePaise: table.minimumChargePaise });
  });

  ownerRouter.put('/:shopId/rates', deps.requireShopAccess, async (req, res) => {
    const tenant = req.tenant!;
    if (tenant.role !== 'owner') {
      throw new HttpError(403, 'Only the shop owner can change prices', 'forbidden');
    }
    const body = RatesBody.parse(req.body);
    await repo.replaceRates(tenant.shopId, body);
    await deps.audit.record({
      actorType: 'user',
      actorId: tenant.userId,
      shopId: tenant.shopId,
      action: 'pricing.rates_updated',
      metadata: { rateCount: body.rates.length, minimumChargePaise: body.minimumChargePaise },
    });
    res.json(body);
  });

  return {
    ownerRouter,
    getRateTable: (shopId: string): Promise<RateTable> => repo.getRateTable(shopId),
    setRates: (shopId: string, body: RatesBody): Promise<void> => repo.replaceRates(shopId, body),
  };
}

export type Pricing = ReturnType<typeof createPricing>;
