// One-off: draws the app and tray icons. Run with: node apps/agent/scripts/make-icons.cjs
const path = require('node:path');
const sharp = require(path.join(__dirname, '../../api/node_modules/sharp'));

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <rect width="256" height="256" rx="56" fill="#0b7a8f"/>
  <rect x="78" y="40" width="100" height="62" rx="6" fill="#ffffff"/>
  <rect x="42" y="92" width="172" height="90" rx="18" fill="#ffffff"/>
  <rect x="78" y="150" width="100" height="66" rx="6" fill="#d9f1f5" stroke="#0b7a8f" stroke-width="8"/>
  <rect x="94" y="168" width="68" height="8" rx="4" fill="#0b7a8f"/>
  <rect x="94" y="186" width="48" height="8" rx="4" fill="#0b7a8f"/>
  <circle cx="186" cy="118" r="9" fill="#0b7a8f"/>
</svg>`;

(async () => {
  const out = path.join(__dirname, '../assets');
  await sharp(Buffer.from(svg(256)))
    .png()
    .toFile(path.join(out, 'icon.png'));
  await sharp(Buffer.from(svg(256)))
    .resize(32, 32)
    .png()
    .toFile(path.join(out, 'tray.png'));
  console.log('icons written');
})();
