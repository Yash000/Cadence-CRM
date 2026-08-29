// Independent verification of the Shopify seed (Task 2), read straight off the store.
import { readFileSync } from 'node:fs';
import { gql } from './lib/shopify.mjs';

const Q = readFileSync(new URL('./gql/verify-shopify-seed.graphql', import.meta.url), 'utf8');
const d = gql(Q);

const orders = d.orders.edges.map(e => e.node);
const customers = d.customers.edges.map(e => e.node);

console.log(`orders    : ${d.ordersCount.count}${d.orders.pageInfo.hasNextPage ? ' (more pages)' : ''}`);
console.log(`customers : ${d.customersCount.count}${d.customers.pageInfo.hasNextPage ? ' (more pages)' : ''}`);

// Orders per customer
const byCustomer = new Map();
for (const o of orders) {
  const id = o.customer?.id ?? '(none)';
  byCustomer.set(id, (byCustomer.get(id) ?? 0) + 1);
}
const counts = [...byCustomer.values()].sort((a, b) => a - b);
const threePlus = counts.filter(c => c >= 3).length;
const hist = {};
for (const c of counts) hist[c] = (hist[c] ?? 0) + 1;

console.log(`\norders/customer histogram (orders → how many customers):`);
for (const k of Object.keys(hist).sort((a, b) => a - b)) console.log(`  ${k}: ${hist[k]}`);
console.log(`customers with >=3 orders: ${threePlus}  (target >=20)`);

// Dates
const dates = orders.map(o => o.processedAt).filter(Boolean).sort();
const undated = orders.filter(o => !o.processedAt).length;
console.log(`\nprocessedAt range: ${dates[0]?.slice(0, 10)} → ${dates.at(-1)?.slice(0, 10)}`);
console.log(`undated orders   : ${undated}  (must be 0)`);

// Phones + orphans
const PHONE = /^\+91[6-9][0-9]{9}$/;
const withPhone = customers.filter(c => c.phone);
const badPhone = withPhone.filter(c => !PHONE.test(c.phone));
const orphans = customers.filter(c => (c.numberOfOrders ?? 0) === 0 || c.numberOfOrders === '0');

console.log(`\ncustomers with phone : ${withPhone.length}/${customers.length}`);
console.log(`invalid phone format : ${badPhone.length}  (must be 0)${badPhone.length ? ' → ' + badPhone.slice(0, 3).map(c => c.phone).join(', ') : ''}`);
console.log(`orphan customers (0 orders): ${orphans.length}  (must be 0)`);
if (orphans.length) console.log('  ' + orphans.slice(0, 12).map(c => c.displayName).join(', '));

const problems =
  (threePlus >= 20 ? 0 : 1) + (undated === 0 ? 0 : 1) +
  (badPhone.length === 0 ? 0 : 1) + (orphans.length === 0 ? 0 : 1);
console.log(problems === 0 ? '\n✓ shape matches spec\n' : `\n✗ ${problems} check(s) failed\n`);
