// Captures the live Shopify product/variant ids into data/shopify-ids.json.
//
//   node --import tsx scripts/capture-shopify-ids.mjs
//   node --import tsx scripts/capture-shopify-ids.mjs --dry-run
//
// Run AFTER scripts/seed-catalogue.mjs has pushed the catalogue to the store,
// and BEFORE scripts/seed-supabase.mjs. The bulk seed writes these ids into
// products.shopify_product_id and order_items.variant_id so the CRM's rows
// point at the real store rather than at invented numbers — which is what
// makes a live `orders/create` webhook resolvable to a seeded row (PRD-02
// §F1.5).
//
// This existed only as a hand-run GraphQL query pasted into the _note field of
// data/shopify-ids.json. That made the one step that connects the store to the
// database the only step with no script, so it is a script now.
import { readFileSync, writeFileSync } from 'node:fs';
import { gql, STORE } from './lib/shopify.mjs';

// Same minimal .env.local reader used elsewhere (e.g. seed-supabase.mjs) —
// split on /\r?\n/ so a CRLF file does not leave a trailing \r inside a value.
// Only used here to report which store this ran against; scripts/lib/shopify.mjs
// gets the actual store from the --store flag, not from this env var.
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* .env.local is optional here */ }

const DRY_RUN = process.argv.includes('--dry-run');

const catalogue = JSON.parse(
  readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'),
);
const target = new URL('../data/shopify-ids.json', import.meta.url);

const QUERY = `
query {
  products(first: 100) {
    edges {
      node {
        id
        handle
        title
        variants(first: 20) { edges { node { id sku title price } } }
      }
    }
  }
}`;

/** "gid://shopify/Product/10410304078120" -> 10410304078120 */
function numericId(gid) {
  const n = Number(String(gid).split('/').pop());
  if (!Number.isSafeInteger(n)) throw new Error(`cannot parse a numeric id out of ${gid}`);
  return n;
}

// The actual store scripts/lib/shopify.mjs runs `shopify app execute` against
// (--store STORE), NOT .env.local's SHOPIFY_STORE_DOMAIN — that var belongs to
// a different code path (the webhook route / verify-shopify-token.mjs) and can
// legitimately name an unrelated domain.
const store = STORE;
console.log(`Reading products from ${store}`);

const edges = gql(QUERY).products.edges;
const live = new Map(edges.map((e) => [e.node.handle, e.node]));
console.log(`  ${live.size} products on the store, ${catalogue.products.length} in the catalogue\n`);

const products = [];
const problems = [];

for (const p of catalogue.products) {
  const node = live.get(p.handle);
  if (!node) {
    problems.push(`${p.handle} — not on the store (run scripts/seed-catalogue.mjs first)`);
    continue;
  }

  const liveVariants = new Map(
    node.variants.edges.map((e) => [e.node.sku, e.node]),
  );

  const variants = [];
  for (const v of p.variants) {
    const lv = liveVariants.get(v.sku);
    if (!lv) {
      problems.push(`${p.handle} — no live variant with sku ${v.sku}`);
      continue;
    }
    // Price is captured for eyeballing only; the catalogue stays the source of
    // truth for money, and a mismatch here means the store drifted from it.
    if (lv.price !== v.price) {
      problems.push(
        `${p.handle} / ${v.sku} — store price ${lv.price} != catalogue price ${v.price}`,
      );
    }
    variants.push({
      sku: v.sku,
      title: v.title,
      price: v.price,
      shopify_variant_id: numericId(lv.id),
    });
  }

  products.push({
    handle: p.handle,
    shopify_product_id: numericId(node.id),
    variants,
  });
  console.log(`  ✓ ${p.handle.padEnd(30)} ${variants.length} variant(s)`);
}

if (problems.length) {
  console.error('\n✗ not captured cleanly:');
  for (const p of problems) console.error(`  · ${p}`);
  console.error('\nNothing written. Fix the store (or the catalogue) and re-run.');
  process.exit(1);
}

const out = {
  _note:
    `Live Shopify IDs for the ${products.length}-product ${catalogue.brand} catalogue, captured from ` +
    `${store}. scripts/seed-supabase.mjs uses these so the CRM products/order_items mirror the ` +
    'real store rather than inventing IDs. Regenerate after a store rebuild with ' +
    'scripts/capture-shopify-ids.mjs.',
  _query: QUERY.replace(/\s+/g, ' ').trim(),
  _capturedAt: new Date().toISOString(),
  store,
  products,
};

if (DRY_RUN) {
  console.log(`\n--dry-run: would write ${products.length} products to data/shopify-ids.json`);
  console.log('  _provisional would be cleared, unblocking scripts/seed-supabase.mjs.');
} else {
  writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
  // The absence of `_provisional` is the signal seed-supabase.mjs checks for.
  console.log(`\n✓ data/shopify-ids.json written — ${products.length} products, real ids.`);
  console.log('  seed-supabase.mjs will now run without --allow-provisional-ids.');
}
