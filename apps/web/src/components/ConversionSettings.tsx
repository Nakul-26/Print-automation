import type { OfficeFamily } from '@print/contracts';
import { Segmented } from './ui';

type Settings = Record<string, unknown>;

const PAPER = [
  { value: 'A4', label: 'A4' },
  { value: 'A3', label: 'A3' },
];
const ORIENTATION = [
  { value: 'auto', label: 'As in file' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];
const MARGINS = [
  { value: 'document', label: 'As in file' },
  { value: 'narrow', label: 'Narrow' },
  { value: 'none', label: 'None' },
];
const FIT = [
  { value: 'fit_width', label: 'Fit width' },
  { value: 'one_page_per_sheet', label: 'One page per sheet' },
  { value: 'actual', label: 'Actual size' },
];

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input
        type="checkbox"
        className="size-5 accent-[var(--color-cyan)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * How a Word, Excel or PowerPoint file becomes a PDF. Every change converts again and the
 * preview refreshes, so the student sees exactly what will be printed.
 */
export function ConversionSettings({
  family,
  settings,
  busy,
  onChange,
}: {
  family: OfficeFamily;
  settings: Settings;
  busy: boolean;
  onChange: (next: Settings) => void;
}) {
  const set = (change: Settings) => onChange({ ...settings, ...change });
  const str = (key: string, fallback: string) =>
    typeof settings[key] === 'string' ? (settings[key] as string) : fallback;
  const bool = (key: string) => settings[key] === true;

  if (family === 'impress') {
    return (
      <div className="space-y-1">
        <Check
          label="Print speaker notes under each slide"
          checked={bool('includeNotes')}
          disabled={busy}
          onChange={(v) => set({ includeNotes: v })}
        />
        <Check
          label="Include hidden slides"
          checked={bool('includeHiddenSlides')}
          disabled={busy}
          onChange={(v) => set({ includeHiddenSlides: v })}
        />
        <p className="text-xs text-muted">
          Choose how many slides go on each sheet under “Pages per sheet” below.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Segmented
        label="Paper"
        value={str('paperSize', 'A4')}
        options={PAPER}
        onChange={(v) => !busy && set({ paperSize: v })}
      />
      <Segmented
        label="Orientation"
        value={str('orientation', 'auto')}
        options={ORIENTATION}
        onChange={(v) => !busy && set({ orientation: v })}
      />
      <Segmented
        label="Margins"
        value={str('margins', 'document')}
        options={MARGINS}
        onChange={(v) => !busy && set({ margins: v })}
      />
      {family === 'calc' && (
        <>
          <Segmented
            label="Fit sheets to the page"
            value={str('fit', 'fit_width')}
            options={FIT}
            onChange={(v) => !busy && set({ fit: v })}
          />
          <Check
            label="Print gridlines"
            checked={bool('gridlines')}
            disabled={busy}
            onChange={(v) => set({ gridlines: v })}
          />
        </>
      )}
    </div>
  );
}
