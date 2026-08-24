// Confirms the catalogue landed as specified in PRD-01 §3, against the live store.
import { readFileSync } from 'node:fs';
import { gql } from './lib/shopify.mjs';

const cat = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'));

const Q = `
query {
  productsCount { count }
  products(first: 50) {
    edges { node {
      handle title status tags
      featuredMedia { id }
      replenishment: metafield(namespace: "custom", key: "replenishment_days") { value }
      collections(first: 5) { edges { node { handle } } }
      variants(first: 10) { edges { node {
        sku price
        vReplenishment: metafield(namespace: "custom", key: "replenishment_days") { value }
      } } }
    } }
  }
}`;

const data = gql(Q);
const live = new Map(data.products.edges.map(e => [e.node.handle, e.node]));

let problems = 0;
const expectedVariants = cat.products.reduce((n, p) => n + p.variants.length, 0);
let liveVariants = 0, withVariantMeta = 0;

console.log(`products on store: ${data.productsCount.count} (expected ${cat.products.length})\n`);

for (const p of cat.products) {
  const l = live.get(p.handle);
  if (!l) { console.log(`✗ ${p.handle} MISSING`); problems++; continue; }

  const issues = [];
  if (l.status !== 'ACTIVE') issues.push(`status=${l.status}`);
  if (!l.featuredMedia) issues.push('no image');
  if (l.replenishment?.value !== String(p.replenishment_days)) {
    issues.push(`product replenishment=${l.replenishment?.value ?? 'MISSING'} expected ${p.replenishment_days}`);
  }
  const cols = l.collections.edges.map(e => e.node.handle);
  if (!cols.includes(p.collection)) issues.push(`not in ${p.collection}`);
  for (const t of p.tags) if (!l.tags.includes(t)) issues.push(`missing tag ${t}`);

  const vs = l.variants.edges.map(e => e.node);
  liveVariants += vs.length;
  if (vs.length !== p.variants.length) issues.push(`${vs.length} variants, expected ${p.variants.length}`);

  for (const spec of p.variants) {
    const v = vs.find(x => x.sku === spec.sku);
    if (!v) { issues.push(`variant ${spec.sku} missing`); continue; }
    if (Number(v.price) !== Number(spec.price)) issues.push(`${spec.sku} price ${v.price} != ${spec.price}`);
    if (v.vReplenishment?.value === String(spec.replenishment_days)) withVariantMeta++;
    else issues.push(`${spec.sku} variant replenishment=${v.vReplenishment?.value ?? 'MISSING'} expected ${spec.replenishment_days}`);
  }

  if (issues.length) { console.log(`✗ ${p.title}\n    ${issues.join('\n    ')}`); problems += issues.length; }
  else console.log(`✓ ${p.title}`);
}

console.log(`\nvariants: ${liveVariants}/${expectedVariants}, with variant-level replenishment_days: ${withVariantMeta}`);
console.log(problems === 0 ? '\n✓ catalogue matches spec\n' : `\n✗ ${problems} problem(s)\n`);
process.exit(problems === 0 ? 0 : 1);
