/** A printer as the shop PC's print agent reports it. */
export interface DetectedPrinter {
  name: string;
  /** null when the driver does not say. */
  isColor: boolean | null;
  supportsDuplex: boolean | null;
  isDefault: boolean;
  offline?: boolean;
}

export type PrinterColorMode = 'black_white' | 'color';

export interface PrinterChoice {
  printerName: string;
  supportsDuplex: boolean;
}

export type PrinterMapping = Record<PrinterColorMode, PrinterChoice | null>;

/** Software "printers" that produce a file or a fax: never a real shop printer. */
const VIRTUAL_PRINTER =
  /(print to pdf|xps document writer|onenote|fax|adobe pdf|pdf24|cutepdf|snagit)/i;

export function isVirtualPrinter(name: string): boolean {
  return VIRTUAL_PRINTER.test(name);
}

const choiceOf = (p: DetectedPrinter): PrinterChoice => ({
  printerName: p.name,
  supportsDuplex: p.supportsDuplex === true,
});

/** The one clear candidate, or null when there is none or the choice is ambiguous. */
function pickOne(candidates: DetectedPrinter[]): DetectedPrinter | null {
  if (candidates.length === 1) return candidates[0]!;
  const defaults = candidates.filter((p) => p.isDefault);
  return defaults.length === 1 ? defaults[0]! : null;
}

/**
 * Fills in whatever the owner has not chosen yet, from what the printers say about themselves:
 * a colour printer for colour jobs, a black-and-white printer for B&W jobs. If the shop only has
 * a colour printer, it also serves black-and-white jobs (printed in monochrome). Existing
 * choices are never changed, and an ambiguous case (two colour printers, say) is left empty for
 * the owner to decide.
 */
export function autoMapPrinters(
  printers: DetectedPrinter[],
  current: PrinterMapping,
): PrinterMapping {
  const real = printers.filter((p) => !isVirtualPrinter(p.name));
  const color = real.filter((p) => p.isColor === true);
  const mono = real.filter((p) => p.isColor === false);

  const colorPick =
    current.color ??
    (() => {
      const p = pickOne(color);
      return p ? choiceOf(p) : null;
    })();

  const monoPick =
    current.black_white ??
    (() => {
      const p = pickOne(mono);
      if (p) return choiceOf(p);
      // No black-and-white printer: a lone colour printer can print in monochrome.
      if (mono.length === 0 && color.length === 1) return choiceOf(color[0]!);
      return null;
    })();

  return { black_white: monoPick, color: colorPick };
}

export type Duplex = 'none' | 'long' | 'short';

/**
 * Which edge to flip on for two-sided jobs: pages that are wider than tall are bound along
 * the short edge (like a wall calendar), everything else along the long edge (like a book).
 */
export function duplexFor(sides: 'single' | 'double', landscape: boolean): Duplex {
  if (sides === 'single') return 'none';
  return landscape ? 'short' : 'long';
}
