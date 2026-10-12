import { describe, expect, it } from 'vitest';
import { autoMapPrinters, duplexFor, isVirtualPrinter, type DetectedPrinter } from './printers.js';

const printer = (name: string, extra: Partial<DetectedPrinter> = {}): DetectedPrinter => ({
  name,
  isColor: null,
  supportsDuplex: true,
  isDefault: false,
  ...extra,
});
const empty = { black_white: null, color: null };

describe('autoMapPrinters', () => {
  it('assigns one colour and one black-and-white printer', () => {
    const mapped = autoMapPrinters(
      [printer('HP LaserJet', { isColor: false }), printer('Epson L3250', { isColor: true })],
      empty,
    );
    expect(mapped.black_white?.printerName).toBe('HP LaserJet');
    expect(mapped.color?.printerName).toBe('Epson L3250');
  });

  it('ignores virtual printers', () => {
    const mapped = autoMapPrinters(
      [
        printer('Microsoft Print to PDF', { isColor: true }),
        printer('Brother HL', { isColor: false }),
      ],
      empty,
    );
    expect(mapped.color).toBeNull();
    expect(mapped.black_white?.printerName).toBe('Brother HL');
    expect(isVirtualPrinter('OneNote (Desktop)')).toBe(true);
    expect(isVirtualPrinter('Canon G3010')).toBe(false);
  });

  it('lets a lone colour printer serve black-and-white jobs too', () => {
    const mapped = autoMapPrinters([printer('Epson L3250', { isColor: true })], empty);
    expect(mapped.color?.printerName).toBe('Epson L3250');
    expect(mapped.black_white?.printerName).toBe('Epson L3250');
  });

  it('leaves an ambiguous choice to the owner, unless one is the default', () => {
    const two = [printer('A', { isColor: true }), printer('B', { isColor: true })];
    expect(autoMapPrinters(two, empty).color).toBeNull();
    const withDefault = [
      printer('A', { isColor: true }),
      printer('B', { isColor: true, isDefault: true }),
    ];
    expect(autoMapPrinters(withDefault, empty).color?.printerName).toBe('B');
  });

  it('never changes what the owner already chose', () => {
    const chosen = { printerName: 'Old', supportsDuplex: false };
    const mapped = autoMapPrinters([printer('New', { isColor: true })], {
      ...empty,
      color: chosen,
    });
    expect(mapped.color).toEqual(chosen);
  });

  it('treats unknown duplex support as unsupported (the owner can switch it on)', () => {
    const mapped = autoMapPrinters([printer('X', { isColor: false, supportsDuplex: null })], empty);
    expect(mapped.black_white?.supportsDuplex).toBe(false);
  });
});

describe('duplexFor', () => {
  it('flips on the long edge for portrait, the short edge for landscape', () => {
    expect(duplexFor('single', false)).toBe('none');
    expect(duplexFor('double', false)).toBe('long');
    expect(duplexFor('double', true)).toBe('short');
  });
});
