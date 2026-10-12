import type { RatesBody } from '@print/contracts';
import type { RateTable } from '@print/domain';
import type { Db } from '../../../platform/db/client.js';

/** The only code in this module that touches the database. */
export function createPricingRepo(db: Db) {
  return {
    async getRateTable(shopId: string): Promise<RateTable> {
      const [rates, pricing] = await Promise.all([
        db.shopRate.findMany({
          where: { shopId },
          orderBy: [{ paperSize: 'asc' }, { colorMode: 'asc' }, { sides: 'asc' }],
        }),
        db.shopPricing.findUnique({ where: { shopId } }),
      ]);
      return {
        rates: rates.map((r) => ({
          paperSize: r.paperSize as 'A4' | 'A3',
          colorMode: r.colorMode as 'black_white' | 'color',
          sides: r.sides as 'single' | 'double',
          pricePerSidePaise: r.pricePerSidePaise,
        })),
        minimumChargePaise: pricing?.minimumChargePaise ?? 0,
      };
    },

    /** Ids of shops that have at least one rate. */
    async shopsWithRates(): Promise<Set<string>> {
      const rows = await db.shopRate.findMany({ select: { shopId: true }, distinct: ['shopId'] });
      return new Set(rows.map((r) => r.shopId));
    },

    /** Replaces all of a shop's rates in one transaction. */
    async replaceRates(shopId: string, body: RatesBody): Promise<void> {
      await db.$transaction([
        db.shopRate.deleteMany({ where: { shopId } }),
        db.shopRate.createMany({
          data: body.rates.map((r) => ({ shopId, ...r })),
        }),
        db.shopPricing.upsert({
          where: { shopId },
          create: { shopId, minimumChargePaise: body.minimumChargePaise },
          update: { minimumChargePaise: body.minimumChargePaise },
        }),
      ]);
    },
  };
}

export type PricingRepo = ReturnType<typeof createPricingRepo>;
