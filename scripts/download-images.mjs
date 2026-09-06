// Downloads the generated product images to data/images/ so the catalogue does
// not depend on the AIBMM storage URLs staying alive.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';

const cat = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'));
const dir = new URL('../data/images/', import.meta.url);
mkdirSync(dir, { recursive: true });

let ok = 0, skipped = 0, failed = 0, missing = 0;

for (const p of cat.products) {
  const out = new URL(`${p.handle}.png`, dir);
  if (existsSync(out)) { console.log(`· ${p.handle} (already present)`); skipped++; continue; }
  // No source to download from. Reported, never treated as a failure: the
  // catalogue is allowed to carry a product whose photography has not been
  // supplied yet, and seed-catalogue.mjs seeds it without media.
  if (!p.image_url) { console.log(`· ${p.handle.padEnd(36)} no image_url in the catalogue`); missing++; continue; }
  try {
    const res = await fetch(p.image_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(out, buf);
    console.log(`✓ ${p.handle.padEnd(36)} ${(buf.length / 1024).toFixed(0)} KB`);
    ok++;
  } catch (e) {
    console.log(`✗ ${p.handle.padEnd(36)} ${e.message}`);
    failed++;
  }
}

console.log(`\n${ok} downloaded, ${skipped} already present, ${missing} without an image_url, ${failed} failed`);
if (missing) {
  console.log(
    `\n${missing} product(s) have no image_url. They will seed to Shopify without\n` +
    'a photo. Add a URL to data/catalogue.json and re-run to attach one.',
  );
}
process.exit(failed === 0 ? 0 : 1);
