// Verifies the custom-app Admin API token: reachable, correct store, and every
// scope PRD-02 §6.1 needs (plus read_all_orders for the 18-month backfill).
//
//   node scripts/verify-shopify-token.mjs
//
// Reads .env.local directly and never prints the token.

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

if (!TOKEN || !DOMAIN) {
  console.error(`Missing in .env.local: ${!TOKEN ? 'SHOPIFY_ADMIN_TOKEN ' : ''}${!DOMAIN ? 'SHOPIFY_STORE_DOMAIN' : ''}`);
  process.exit(1);
}
if (!/^shpat_/.test(TOKEN)) {
  console.error('SHOPIFY_ADMIN_TOKEN does not start with "shpat_" — that prefix marks a custom-app');
  console.error('offline token. An "shpca_"/"shpss_" value is the wrong credential type here.');
  process.exit(1);
}

async function admin(query, variables) {
  const res = await fetch(`https://${DOMAIN}/admin/api/${VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

// PRD-02 §6.1 + read_all_orders (plain read_orders caps at 60 days of history).
const REQUIRED = [
  'read_products', 'write_products',
  'read_customers', 'write_customers',
  'read_orders', 'write_orders', 'read_all_orders',
  'read_checkouts',
  'read_discounts', 'write_discounts',
];

let failures = 0;

const shop = await admin('query { shop { name myshopifyDomain currencyCode ianaTimezone plan { displayName partnerDevelopment } } }');
const s = shop.shop;

console.log(`\nstore     : ${s.name} (${s.myshopifyDomain})`);
console.log(`currency  : ${s.currencyCode}   timezone: ${s.ianaTimezone}`);
console.log(`plan      : ${s.plan.displayName}   partnerDevelopment: ${s.plan.partnerDevelopment}`);
console.log(`api       : ${VERSION}\n`);

if (s.myshopifyDomain !== DOMAIN) {
  console.error(`✗ token belongs to ${s.myshopifyDomain}, not ${DOMAIN}`);
  failures++;
}
if (s.currencyCode !== 'INR') { console.error(`✗ currency is ${s.currencyCode}, expected INR`); failures++; }

const inst = await admin('query { currentAppInstallation { accessScopes { handle } } }');
const granted = new Set(inst.currentAppInstallation.accessScopes.map(x => x.handle));

for (const scope of REQUIRED) {
  const ok = granted.has(scope);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${scope}`);
}

const extra = [...granted].filter(g => !REQUIRED.includes(g));
if (extra.length) console.log(`\n  also granted: ${extra.join(', ')}`);

console.log(
  failures === 0
    ? '\n✓ token valid, correct store, all required scopes granted\n'
    : `\n✗ ${failures} problem(s) — fix before seeding\n`
);
process.exit(failures === 0 ? 0 : 1);
