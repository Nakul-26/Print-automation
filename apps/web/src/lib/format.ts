import type { OrderView, PrintSettings, RateEntry } from '@print/contracts';

export { formatRupees } from '@print/domain';

export const PAPER_LABEL = { A4: 'A4', A3: 'A3' } as const;
export const COLOR_LABEL = { black_white: 'Black & white', color: 'Colour' } as const;
export const SIDES_LABEL = { single: 'One side', double: 'Both sides' } as const;

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeSettings(s: PrintSettings): string {
  const parts = [
    COLOR_LABEL[s.colorMode],
    s.sides === 'double' ? 'both sides' : 'one side',
    s.paperSize,
    `${s.copies} ${s.copies === 1 ? 'copy' : 'copies'}`,
  ];
  if (s.pagesPerSheet > 1) parts.push(`${s.pagesPerSheet} pages per sheet`);
  if (s.pageSelection === 'custom' && s.pages) parts.push(`pages ${s.pages}`);
  return parts.join(' · ');
}

/** What the order status means for the student, in plain words. */
export function statusCopy(status: OrderView['status']): {
  title: string;
  detail: string;
  tone: 'wait' | 'go' | 'done' | 'bad';
} {
  switch (status) {
    case 'processing':
      return {
        title: 'Getting your files ready',
        detail: 'This takes a few seconds.',
        tone: 'wait',
      };
    case 'pending':
      return {
        title: 'Waiting for the shop',
        detail: 'Stay nearby. They will call your number.',
        tone: 'wait',
      };
    case 'accepted':
      return {
        title: 'Accepted',
        detail: 'The shop will call your number when it is your turn.',
        tone: 'go',
      };
    case 'printing':
      return { title: 'Printing now', detail: 'Head to the counter.', tone: 'go' };
    case 'completed':
      return { title: 'Done', detail: 'Thank you.', tone: 'done' };
    case 'rejected':
      return { title: 'The shop could not take this order', detail: '', tone: 'bad' };
    case 'failed':
      return {
        title: 'Something went wrong',
        detail: 'Your files could not be prepared. Please place the order again.',
        tone: 'bad',
      };
    case 'expired':
      return {
        title: 'This order expired',
        detail: 'Files are kept for one day. Place the order again.',
        tone: 'bad',
      };
    default:
      return { title: status, detail: '', tone: 'wait' };
  }
}

/** Which options the shop's rate card offers, so the form never lets a student pick the impossible. */
export function offered(rates: RateEntry[]) {
  const has = (p: string, c?: string, s?: string) =>
    rates.some((r) => r.paperSize === p && (!c || r.colorMode === c) && (!s || r.sides === s));
  return {
    paper: (['A4', 'A3'] as const).filter((p) => has(p)),
    color: (paper: string) => (['black_white', 'color'] as const).filter((c) => has(paper, c)),
    sides: (paper: string, color: string) =>
      (['single', 'double'] as const).filter((s) => has(paper, color, s)),
  };
}

export function firstAvailable(
  rates: RateEntry[],
): Pick<PrintSettings, 'paperSize' | 'colorMode' | 'sides'> {
  const preferred = rates.find(
    (r) => r.paperSize === 'A4' && r.colorMode === 'black_white' && r.sides === 'single',
  );
  const pick = preferred ?? rates[0];
  return pick
    ? { paperSize: pick.paperSize, colorMode: pick.colorMode, sides: pick.sides }
    : { paperSize: 'A4', colorMode: 'black_white', sides: 'single' };
}
