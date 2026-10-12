import { describe, expect, it } from 'vitest';
import {
  findRate,
  formatQueueNumber,
  formatRupees,
  priceItem,
  priceOrder,
  type RateTable,
} from './pricing.js';

const table: RateTable = {
  minimumChargePaise: 200,
  rates: [
    { paperSize: 'A4', colorMode: 'black_white', sides: 'single', pricePerSidePaise: 200 },
    { paperSize: 'A4', colorMode: 'black_white', sides: 'double', pricePerSidePaise: 150 },
    { paperSize: 'A4', colorMode: 'color', sides: 'single', pricePerSidePaise: 1000 },
  ],
};

const base = {
  selectedPageCount: 5,
  copies: 2,
  colorMode: 'black_white',
  sides: 'single',
  paperSize: 'A4',
  pagesPerSheet: 1,
} as const;

describe('priceItem', () => {
  it('charges per printed side: 5 pages x 2 copies at 2 rupees = 20 rupees', () => {
    const r = priceItem(base, table);
    expect(r).toMatchObject({ ok: true, printedSides: 10, sheets: 10, amountPaise: 2000 });
  });

  it('uses the double-sided rate and halves the sheets', () => {
    const r = priceItem({ ...base, sides: 'double' }, table);
    // 5 sides per copy -> 3 sheets per copy (last sheet blank on the back); 10 sides charged
    expect(r).toMatchObject({
      ok: true,
      sidesPerCopy: 5,
      sheetsPerCopy: 3,
      sheets: 6,
      printedSides: 10,
      amountPaise: 1500,
    });
  });

  it('puts several pages on each side when pagesPerSheet > 1', () => {
    const two = priceItem({ ...base, selectedPageCount: 5, copies: 1, pagesPerSheet: 2 }, table);
    expect(two).toMatchObject({ ok: true, sidesPerCopy: 3, amountPaise: 600 });
    const four = priceItem({ ...base, selectedPageCount: 9, copies: 1, pagesPerSheet: 4 }, table);
    expect(four).toMatchObject({ ok: true, sidesPerCopy: 3 });
  });

  it('combines double-sided with 2-up', () => {
    const r = priceItem(
      { ...base, selectedPageCount: 8, copies: 1, sides: 'double', pagesPerSheet: 2 },
      table,
    );
    // 4 printed sides on 2 sheets
    expect(r).toMatchObject({ ok: true, sidesPerCopy: 4, sheetsPerCopy: 2, amountPaise: 600 });
  });

  it('uses the colour rate', () => {
    const r = priceItem({ ...base, colorMode: 'color', copies: 1 }, table);
    expect(r).toMatchObject({ ok: true, amountPaise: 5000 });
  });

  it('reports a missing rate instead of guessing', () => {
    expect(priceItem({ ...base, paperSize: 'A3' }, table)).toEqual({
      ok: false,
      error: 'rate_unavailable',
    });
    expect(priceItem({ ...base, colorMode: 'color', sides: 'double' }, table)).toEqual({
      ok: false,
      error: 'rate_unavailable',
    });
  });

  it.each([
    { selectedPageCount: 0 },
    { selectedPageCount: 1.5 },
    { copies: 0 },
    { copies: -1 },
    { pagesPerSheet: 3 },
  ])('rejects invalid input %j', (override) => {
    expect(priceItem({ ...base, ...override } as never, table)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('never produces fractional paise', () => {
    for (let pages = 1; pages <= 40; pages++) {
      for (const pps of [1, 2, 4] as const) {
        const r = priceItem({ ...base, selectedPageCount: pages, pagesPerSheet: pps }, table);
        expect(r.ok && Number.isInteger(r.amountPaise)).toBe(true);
      }
    }
  });
});

describe('priceOrder', () => {
  it('sums items', () => {
    expect(priceOrder([2000, 500], 200)).toEqual({
      subtotalPaise: 2500,
      minimumChargePaise: 200,
      minimumApplied: false,
      totalPaise: 2500,
    });
  });
  it('applies the minimum charge', () => {
    expect(priceOrder([100], 200)).toMatchObject({ totalPaise: 200, minimumApplied: true });
  });
});

describe('helpers', () => {
  it('finds rates by key', () => {
    expect(findRate(table, { paperSize: 'A4', colorMode: 'color', sides: 'single' })).toBeDefined();
    expect(
      findRate(table, { paperSize: 'A3', colorMode: 'color', sides: 'single' }),
    ).toBeUndefined();
  });
  it('formats queue numbers and rupees', () => {
    expect(formatQueueNumber(7)).toBe('P007');
    expect(formatQueueNumber(1234)).toBe('P1234');
    expect(formatRupees(2000)).toBe('₹20');
    expect(formatRupees(1550)).toBe('₹15.50');
  });
});
