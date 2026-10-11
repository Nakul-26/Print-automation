export type PageRangeResult = { ok: true; pages: number[] } | { ok: false; error: string };

/**
 * Parses a user page selection such as "1-5, 8, 11-13" against a document's page count.
 * Returns the sorted, de-duplicated list of 1-based page numbers.
 */
export function parsePageRanges(input: string, totalPages: number): PageRangeResult {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'Page selection is empty' };
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    return { ok: false, error: 'Document has no pages' };
  }

  const pages = new Set<number>();
  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) return { ok: false, error: `Invalid page range: "${part}"` };

    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < 1) return { ok: false, error: 'Pages start at 1' };
    if (start > end) return { ok: false, error: `Range "${part}" is backwards` };
    if (end > totalPages) {
      return { ok: false, error: `Page ${end} is beyond the last page (${totalPages})` };
    }
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}
