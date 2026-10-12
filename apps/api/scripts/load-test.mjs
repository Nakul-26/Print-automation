// Simulates a burst of students uploading documents at once and measures how long it takes until
// each one is ready (the wait they would feel before seeing a preview).
//
//   node scripts/load-test.mjs --base https://print-staging.fiveorbit.tech --shop <slug> \
//        --students 40 --over 20 --pages 12 [--preview]
//
// --students  how many students                 --over   seconds they arrive within
// --pages     pages per document (a few are made larger so the mix is not uniform)
// --preview   also download the print preview once ready (exercises the preview gate)
//
// Run it against STAGING only. Raise UPLOAD_RATE_LIMIT_MAX and API_RATE_LIMIT_MAX there first, or
// the per-IP limits (correctly) turn most of the test into 429s. See docs/load-testing.md.
import { parseArgs } from 'node:util';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    shop: { type: 'string' },
    students: { type: 'string', default: '30' },
    over: { type: 'string', default: '15' },
    pages: { type: 'string', default: '10' },
    timeout: { type: 'string', default: '180' },
    preview: { type: 'boolean', default: false },
  },
});
if (!values.base || !values.shop) {
  console.error(
    'Usage: node scripts/load-test.mjs --base <url> --shop <slug> [--students N --over S --pages P --preview]',
  );
  process.exit(2);
}
const base = values.base.replace(/\/$/, '');
const students = Number(values.students);
const overMs = Number(values.over) * 1000;
const pages = Number(values.pages);
const timeoutMs = Number(values.timeout) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN;
const secs = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) + ' s' : '–');

async function makePdf(n, seed) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= n; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 50, y: 300, width: 300, height: 200, color: rgb(0.8, 0.1, 0.1) });
    page.drawText(`Student ${seed} - page ${i}`, { x: 60, y: 520, size: 28, font });
  }
  return Buffer.from(await doc.save());
}

const results = [];
const tally = {};
const count = (key) => (tally[key] = (tally[key] ?? 0) + 1);

async function student(i) {
  const r = { i, ok: false };
  results.push(r);
  const n = i % 7 === 0 ? pages * 3 : pages; // every 7th student has a long document
  const pdf = await makePdf(n, i);
  const form = new FormData();
  form.set('file', new Blob([pdf], { type: 'application/pdf' }), `notes-${i}.pdf`);
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${base}/api/v1/shops/${values.shop}/uploads`, {
      method: 'POST',
      body: form,
    });
  } catch (err) {
    count('upload network error');
    r.error = String(err);
    return;
  }
  r.uploadMs = performance.now() - t0;
  if (res.status !== 201) {
    count(`upload HTTP ${res.status}`);
    r.error = `upload ${res.status}`;
    return;
  }
  const { token, upload } = await res.json();
  r.aheadAtStart = upload.queueAhead ?? 0;
  const deadline = t0 + timeoutMs;
  for (;;) {
    if (performance.now() > deadline) {
      count('not ready in time');
      return;
    }
    await sleep(700);
    const poll = await fetch(`${base}/api/v1/uploads/${token}`).catch(() => null);
    if (!poll?.ok) {
      if (poll) count(`poll HTTP ${poll.status}`);
      continue;
    }
    const view = await poll.json();
    if (view.status === 'ready') break;
    if (view.status === 'failed') {
      count('processing failed');
      return;
    }
  }
  r.readyMs = performance.now() - t0;
  if (values.preview) {
    const p0 = performance.now();
    for (let attempt = 0; attempt < 6; attempt++) {
      const pv = await fetch(`${base}/api/v1/uploads/${token}/preview`).catch(() => null);
      if (pv?.ok) {
        await pv.arrayBuffer();
        r.previewMs = performance.now() - p0;
        break;
      }
      if (pv?.status === 503) {
        count('preview busy (503, client retries)');
        await sleep(3000);
      } else {
        count(`preview HTTP ${pv?.status ?? 'error'}`);
        break;
      }
    }
  }
  r.ok = true;
}

console.log(
  `Sending ${students} students over ${values.over}s to ${base} (shop ${values.shop}, ~${pages} pages each)`,
);
const started = performance.now();
const all = [];
for (let i = 0; i < students; i++) {
  all.push(student(i));
  if (i < students - 1) await sleep(overMs / students);
}
await Promise.all(all);
const total = performance.now() - started;

const good = results.filter((r) => r.ok);
const ready = good.map((r) => r.readyMs).sort((a, b) => a - b);
const up = results
  .filter((r) => r.uploadMs)
  .map((r) => r.uploadMs)
  .sort((a, b) => a - b);
const prev = good
  .filter((r) => r.previewMs)
  .map((r) => r.previewMs)
  .sort((a, b) => a - b);
console.log('\n--- result ---');
console.log(`finished in ${secs(total)}; ${good.length}/${students} students got a ready document`);
console.log(`upload accepted:   median ${secs(pct(up, 50))}, 95th ${secs(pct(up, 95))}`);
console.log(
  `time until ready:  median ${secs(pct(ready, 50))}, 95th ${secs(pct(ready, 95))}, slowest ${secs(ready.at(-1))}`,
);
if (values.preview)
  console.log(`preview download:  median ${secs(pct(prev, 50))}, 95th ${secs(pct(prev, 95))}`);
console.log(
  `most files ahead of someone: ${Math.max(0, ...results.map((r) => r.aheadAtStart ?? 0))}`,
);
if (Object.keys(tally).length) {
  console.log('problems:');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${v} x ${k}`);
}
const bad = good.length < students;
console.log(
  bad
    ? '\nVERDICT: some students did not get a document. Do not raise the load until this is understood.'
    : `\nVERDICT: everyone was served. A student's 95th-percentile wait was ${secs(pct(ready, 95))}.`,
);
process.exit(bad ? 1 : 0);
