// One-off: archives the 12 Rasaya products left on the store after the
// HomeStyle rebrand (seed-catalogue.mjs upserts by handle, so a handle from
// the old catalogue is never touched by it). Archiving, not deleting — fully
// reversible, and it stops them showing on the storefront and in default
// admin product lists.
//
//   node --import tsx scripts/archive-old-products.mjs
//   node --import tsx scripts/archive-old-products.mjs --dry-run
import { readFileSync } from 'node:fs';
import { gql } from './lib/shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

const oldIds = JSON.parse(
  readFileSync(new URL('../data/shopify-ids.rasaya.bak.json', import.meta.url), 'utf8'),
);

const PRODUCT_BY_HANDLE = `
query ($handle: String!) {
  productByIdentifier(identifier: { handle: $handle }) { id title status }
}`;

const ARCHIVE = `
mutation ($input: ProductInput!) {
  productUpdate(input: $input) {
    product { id title status }
    userErrors { field message }
  }
}`;

console.log(`Archiving ${oldIds.products.length} pre-rebrand products (from ${oldIds.store})\n`);

let archived = 0, alreadyDone = 0, missing = 0, failed = 0;

for (const p of oldIds.products) {
  let live;
  try {
    live = gql(PRODUCT_BY_HANDLE, { handle: p.handle })?.productByIdentifier;
  } catch (e) {
    console.log(`✗ ${p.handle.padEnd(36)} lookup failed: ${e.message.slice(0, 100)}`);
    failed++;
    continue;
  }

  if (!live) {
    console.log(`· ${p.handle.padEnd(36)} not on the store (already removed)`);
    missing++;
    continue;
  }

  if (live.status === 'ARCHIVED') {
    console.log(`· ${p.handle.padEnd(36)} already archived`);
    alreadyDone++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`  ${p.handle.padEnd(36)} would archive (currently ${live.status})`);
    continue;
  }

  try {
    const res = gql(ARCHIVE, { input: { id: live.id, status: 'ARCHIVED' } }).productUpdate;
    console.log(`  ✓ ${p.handle.padEnd(36)} ${live.status} → ${res.product.status}`);
    archived++;
  } catch (e) {
    console.log(`  ✗ ${p.handle.padEnd(36)} ${e.message.slice(0, 100)}`);
    failed++;
  }
}

console.log(
  `\n${DRY_RUN ? '(dry run) ' : ''}${archived} archived, ${alreadyDone} already archived, ` +
  `${missing} not found, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
