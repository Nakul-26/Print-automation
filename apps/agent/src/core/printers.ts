import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AgentPrinter } from '@print/contracts';
import type { PrinterLister } from './types.js';

/** Win32_Printer.Capabilities (CIM_Printer): 2 = colour printing, 3 / 13-15 = two-sided, 11 = black and white. */
const CAP_COLOR = 2;
const CAP_DUPLEX = [3, 13, 14, 15];

interface WinPrinter {
  Name?: unknown;
  Default?: unknown;
  WorkOffline?: unknown;
  Capabilities?: unknown;
}

/**
 * Turns the output of `Get-CimInstance Win32_Printer | ConvertTo-Json` into our printer list.
 * Drivers describe themselves loosely: a capability list that does not mention colour means a
 * black-and-white printer, and no list at all means "unknown" (the owner can still choose it).
 */
export function parseWindowsPrinters(json: string): AgentPrinter[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as WinPrinter | WinPrinter[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const printers: AgentPrinter[] = [];
  for (const row of rows) {
    if (typeof row.Name !== 'string' || row.Name.length === 0) continue;
    const caps = Array.isArray(row.Capabilities)
      ? row.Capabilities.filter((c): c is number => typeof c === 'number')
      : [];
    const known = caps.length > 0;
    printers.push(
      AgentPrinter.parse({
        name: row.Name.slice(0, 200),
        isColor: known ? caps.includes(CAP_COLOR) : null,
        supportsDuplex: known ? CAP_DUPLEX.some((c) => caps.includes(c)) : null,
        isDefault: row.Default === true,
        offline: row.WorkOffline === true,
      }),
    );
  }
  return printers;
}

const POWERSHELL_SCRIPT =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Printer | Select-Object Name, Default, WorkOffline, Capabilities | ConvertTo-Json -Compress';

export class WindowsPrinterLister implements PrinterLister {
  list(): Promise<AgentPrinter[]> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT],
        { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            resolve(parseWindowsPrinters(stdout));
          } catch (parseError) {
            reject(parseError as Error);
          }
        },
      );
    });
  }
}

/** A fixed list read from a JSON file: for development on a PC without the real printers. */
export class FilePrinterLister implements PrinterLister {
  constructor(private readonly file: string) {}
  async list(): Promise<AgentPrinter[]> {
    const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown[];
    return raw.map((p) => AgentPrinter.parse(p));
  }
}
