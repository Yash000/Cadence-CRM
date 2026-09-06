// Pushes the HomeStyle catalogue (data/catalogue.json, PRD-01 §3) to the dev store.
//
//   node scripts/seed-catalogue.mjs
//
// Idempotent: products are matched by handle and updated in place, so re-runs
// are safe and the script survives a store change (PRD-01 §10).

import { readFileSync } from 'node:fs';
import { gql } from './lib/shopify.mjs';

const cat = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'));

// ── collections ──────────────────────────────────────────────────────────────
const COLLECTION_BY_HANDLE = `
query ($handle: String!) {
  collectionByIdentifier(identifier: { handle: $handle }) { id title }
}`;

const CREATE_COLLECTION = `
mutation ($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id handle title }
    userErrors { field message }
  }
}`;

const collectionIds = {};
console.log('Collections');
for (const c of cat.collections) {
  let existing = null;
  try {
    existing = gql(COLLECTION_BY_HANDLE, { handle: c.handle })?.collectionByIdentifier;
  } catch { /* not found — fall through to create */ }

  if (existing) {
    collectionIds[c.handle] = existing.id;
    console.log(`  · ${c.title.padEnd(12)} exists`);
  } else {
    const made = gql(CREATE_COLLECTION, {
      input: {
        handle: c.handle,
        title: c.title,
        // care-decor is the only genuinely repeat-purchase collection; the three
        // room collections are projects, and cycle_days is how long a room
        // typically takes to complete once its anchor piece lands.
        descriptionHtml:
          c.handle === 'care-decor'
            ? `<p>${c.title} — typical repurchase cycle ${c.cycle_days} days.</p>`
            : `<p>${c.title} — rooms are typically completed within ${c.cycle_days} days of the first piece.</p>`,
      },
    }).collectionCreate.collection;
    collectionIds[c.handle] = made.id;
    console.log(`  ✓ ${c.title.padEnd(12)} created`);
  }
}

// ── products ─────────────────────────────────────────────────────────────────
const PRODUCT_BY_HANDLE = `
query ($handle: String!) {
  productByIdentifier(identifier: { handle: $handle }) { id title }
}`;

const PRODUCT_SET = `
mutation ($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product {
      id
      handle
      status
      variants(first: 10) { edges { node { sku price } } }
      media(first: 5) { edges { node { id } } }
    }
    userErrors { field message }
  }
}`;

console.log('\nProducts');
let created = 0, updated = 0, failed = 0;

for (const p of cat.products) {
  let existingId = null;
  try {
    existingId = gql(PRODUCT_BY_HANDLE, { handle: p.handle })?.productByIdentifier?.id ?? null;
  } catch { /* not found */ }

  const filename = `${p.handle}.png`;

  const input = {
    ...(existingId ? { id: existingId } : {}),
    handle: p.handle,
    title: p.title,
    descriptionHtml:
      `<p>${p.description}</p>` +
      `<p><strong>Materials.</strong> ${p.materials}</p>`,
    productType: p.product_type,
    vendor: cat.brand,
    status: 'ACTIVE',
    tags: [...p.tags, p.collection, `role:${p.role}`],
    collections: [collectionIds[p.collection]],
    // Product-level per PRD-01 §3.2 …
    metafields: [
      { namespace: 'custom', key: 'replenishment_days', type: 'number_integer', value: String(p.replenishment_days) },
      { namespace: 'custom', key: 'piece_tags', type: 'single_line_text_field', value: p.tags.join(', ') },
      { namespace: 'custom', key: 'tier', type: 'single_line_text_field', value: p.role },
    ],
    // A product with no image still seeds. The HomeStyle catalogue ships with
    // image_url empty because furniture photography has to be supplied rather
    // than generated, and a store that refuses to seed until every render
    // exists blocks the whole pipeline on an asset. Shopify rejects a `files`
    // entry with an empty originalSource, so the key is omitted entirely.
    ...(p.image_url ? { files: [{ originalSource: p.image_url, contentType: 'IMAGE', alt: p.title, filename }] } : {}),
    productOptions: [{
      // Named per product: a sofa varies by Size, a coffee table by Shape, a
      // dining table by Seats. One hardcoded 'Size' across a furniture
      // catalogue puts 'Round / Rectangular' under a heading that does not
      // describe them, on the live storefront.
      name: p.option_name ?? 'Size',
      values: p.variants.map(v => ({ name: v.title })),
    }],
    // … and per variant, because sizes deplete at different rates and §F3.4
    // predicts next-order-date from this number.
    variants: p.variants.map((v, i) => ({
      optionValues: [{ optionName: p.option_name ?? 'Size', name: v.title }],
      price: v.price,
      sku: v.sku,
      position: i + 1,
      taxable: true,
      inventoryItem: { tracked: false, requiresShipping: true },
      metafields: [
        { namespace: 'custom', key: 'replenishment_days', type: 'number_integer', value: String(v.replenishment_days) },
      ],
    })),
  };

  try {
    const res = gql(PRODUCT_SET, { input }).productSet.product;
    const media = res.media.edges.length;
    console.log(
      `  ${existingId ? '↻' : '✓'} ${p.title.padEnd(34)} ` +
      `${String(res.variants.edges.length)} var  ${media ? 'img' : 'NO IMG'}  ${res.status}`
    );
    existingId ? updated++ : created++;
  } catch (e) {
    console.log(`  ✗ ${p.title.padEnd(34)} ${e.message.slice(0, 150)}`);
    failed++;
  }
}

console.log(`\n${created} created, ${updated} updated, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
