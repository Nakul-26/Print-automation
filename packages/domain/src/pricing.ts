/**
 * Price calculation. Pure and integer-only: all money is in paise (1/100 rupee) so there is
 * never any floating-point rounding.
 *
 * The unit is the PRINTED SIDE: every side of paper that carries print is charged at the
 * shop's rate for that paper size, colour mode, and single/double-sided choice.
 */

export type PaperSize = 'A4' | 'A3';
export type ColorMode = 'black_white' | 'color';
export type Sides = 'single' | 'double';

export interface Rate {
  paperSize: PaperSize;
  colorMode: ColorMode;
  sides: Sides;
  pricePerSidePaise: number;
}

export interface RateTable {
  rates: readonly Rate[];
  /** The smallest amount a shop charges for any order. */
  minimumChargePaise: number;
}

export interface ItemPriceInput {
  /** Pages the student chose to print from this document (one copy). */
  selectedPageCount: number;
  copies: number;
  colorMode: ColorMode;
  sides: Sides;
  paperSize: PaperSize;
  /** Logical pages placed on each side of a sheet (1, 2, or 4). */
  pagesPerSheet: 1 | 2 | 4;
}

export interface ItemPrice {
  /** Printed sides for ONE copy. */
  sidesPerCopy: number;
  /** Physical sheets for ONE copy (double-sided uses one sheet for two sides). */
  sheetsPerCopy: number;
  /** Printed sides across all copies: what is charged. */
  printedSides: number;
  /** Physical sheets across all copies. */
  sheets: number;
  pricePerSidePaise: number;
  amountPaise: number;
}

export type ItemPriceResult =
  | ({ ok: true } & ItemPrice)
  | { ok: false; error: 'rate_unavailable' | 'invalid_input' };

export function findRate(
  table: RateTable,
  key: Pick<Rate, 'paperSize' | 'colorMode' | 'sides'>,
): Rate | undefined {
  return table.rates.find(
    (r) => r.paperSize === key.paperSize && r.colorMode === key.colorMode && r.sides === key.sides,
  );
}

export function priceItem(input: ItemPriceInput, table: RateTable): ItemPriceResult {
  const { selectedPageCount, copies, pagesPerSheet } = input;
  if (
    !Number.isInteger(selectedPageCount) ||
    selectedPageCount < 1 ||
    !Number.isInteger(copies) ||
    copies < 1 ||
    ![1, 2, 4].includes(pagesPerSheet)
  ) {
    return { ok: false, error: 'invalid_input' };
  }

  const rate = findRate(table, input);
  if (!rate) return { ok: false, error: 'rate_unavailable' };

  const sidesPerCopy = Math.ceil(selectedPageCount / pagesPerSheet);
  const sheetsPerCopy = input.sides === 'double' ? Math.ceil(sidesPerCopy / 2) : sidesPerCopy;
  const printedSides = sidesPerCopy * copies;

  return {
    ok: true,
    sidesPerCopy,
    sheetsPerCopy,
    printedSides,
    sheets: sheetsPerCopy * copies,
    pricePerSidePaise: rate.pricePerSidePaise,
    amountPaise: printedSides * rate.pricePerSidePaise,
  };
}

export interface OrderTotal {
  subtotalPaise: number;
  minimumChargePaise: number;
  /** True when the minimum charge raised the total above the sum of the items. */
  minimumApplied: boolean;
  totalPaise: number;
}

export function priceOrder(itemAmountsPaise: readonly number[], minimumChargePaise: number): OrderTotal {
  const subtotalPaise = itemAmountsPaise.reduce((sum, a) => sum + a, 0);
  const totalPaise = Math.max(subtotalPaise, minimumChargePaise);
  return {
    subtotalPaise,
    minimumChargePaise,
    minimumApplied: totalPaise > subtotalPaise,
    totalPaise,
  };
}

/** "P014": the number the student is called by. */
export function formatQueueNumber(sequence: number): string {
  return `P${String(sequence).padStart(3, '0')}`;
}

export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return Number.isInteger(rupees) ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}
