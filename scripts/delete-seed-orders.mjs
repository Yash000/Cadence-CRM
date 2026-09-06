// One-off: deletes every order scripts/seed-shopify.mjs previously created,
// so a re-run starts from a clean slate rather than the old Rasaya order set.
//
//   node --import tsx scripts/delete-seed-orders.mjs
//   node --import tsx scripts/delete-seed-orders.mjs --dry-run
//
// Scoped to orders tagged `cadence-seed` — the exact tag seed-shopify.mjs puts
// on every order it creates (see pushOrdersAsync). Never touches an order that
// does not carry that tag, so this cannot reach a real customer order.
import { gql } from './lib/shopify.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

function fetchSeedOrders() {
  const orders = [];
  let after = null;
  for (;;) {
    const data = gql(
      `query ($after: String) { orders(first: 100, after: $after, query: "tag:cadence-seed") {
         edges { cursor node { id name } }
         pageInfo { hasNextPage }
       } }`,
      { after },
    );
    for (const edge of data.orders.edges) {
      orders.push(edge.node);
      after = edge.cursor;
    }
    if (!data.orders.pageInfo.hasNextPage) break;
  }
  return orders;
}

const ORDER_DELETE = `
mutation ($orderId: ID!) {
  orderDelete(orderId: $orderId) {
    deletedId
    userErrors { field message }
  }
}`;

console.log('Finding orders tagged cadence-seed…');
const orders = fetchSeedOrders();
console.log(`  ${orders.length} orders found\n`);

if (!orders.length) {
  console.log('Nothing to delete.');
  process.exit(0);
}

if (DRY_RUN) {
  for (const o of orders) console.log(`  would delete ${o.name} (${o.id})`);
  console.log(`\n(dry run) ${orders.length} orders would be deleted`);
  process.exit(0);
}

let deleted = 0, failed = 0;
for (const o of orders) {
  try {
    const res = gql(ORDER_DELETE, { orderId: o.id }).orderDelete;
    if (res.userErrors.length) {
      console.log(`  ✗ ${o.name} — ${res.userErrors.map((e) => e.message).join('; ')}`);
      failed++;
    } else {
      console.log(`  ✓ ${o.name} deleted`);
      deleted++;
    }
  } catch (e) {
    console.log(`  ✗ ${o.name} — ${e.message.slice(0, 150)}`);
    failed++;
  }
}

console.log(`\n${deleted} deleted, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
