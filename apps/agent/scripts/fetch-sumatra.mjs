// Downloads the portable SumatraPDF that the app prints with, and checks it against a pinned
// SHA-256 so a tampered download can never end up inside the installer.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const VERSION = '3.6.1';
const ZIP_SHA256 = '98b33a518d42986856d225064b0cd2d3643ecf78cbf84ab873d26cc51877a544';
const URL = `https://www.sumatrapdfreader.org/dl/rel/${VERSION}/SumatraPDF-${VERSION}-64.zip`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'vendor', 'sumatra');
const target = join(outDir, 'SumatraPDF.exe');

if (existsSync(target)) {
  console.log(`SumatraPDF ${VERSION} already in place.`);
  process.exit(0);
}

console.log(`Downloading SumatraPDF ${VERSION}…`);
const res = await fetch(URL, { redirect: 'follow' });
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const zip = Buffer.from(await res.arrayBuffer());
const actual = createHash('sha256').update(zip).digest('hex');
if (actual !== ZIP_SHA256) {
  throw new Error(`SumatraPDF checksum mismatch.\n  expected ${ZIP_SHA256}\n  got      ${actual}`);
}

mkdirSync(outDir, { recursive: true });
const zipFile = join(root, 'vendor', 'sumatra.zip');
writeFileSync(zipFile, zip);
if (process.platform === 'win32') {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${outDir}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('unzip', ['-o', '-q', zipFile, '-d', outDir]);
}
rmSync(zipFile);
const extracted = join(outDir, `SumatraPDF-${VERSION}-64.exe`);
writeFileSync(target, readFileSync(extracted));
rmSync(extracted);
console.log(`Ready: ${target}`);
