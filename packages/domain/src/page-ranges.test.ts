import { describe, expect, it } from 'vitest';
import { parsePageRanges } from './page-ranges.js';

describe('parsePageRanges', () => {
  it('parses single pages and ranges', () => {
    expect(parsePageRanges('1-3, 5, 8-9', 10)).toEqual({ ok: true, pages: [1, 2, 3, 5, 8, 9] });
  });
  it('de-duplicates and sorts', () => {
    expect(parsePageRanges('5, 1-3, 2', 10)).toEqual({ ok: true, pages: [1, 2, 3, 5] });
  });
  it.each(['', 'a', '0', '3-1', '1-', '1,,2', '-5'])('rejects %j', (input) => {
    expect(parsePageRanges(input, 10).ok).toBe(false);
  });
  it('rejects pages beyond the document', () => {
    expect(parsePageRanges('1-11', 10).ok).toBe(false);
  });
});
