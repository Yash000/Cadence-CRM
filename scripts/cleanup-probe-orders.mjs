// Removes every order tagged `cadence-probe` so rate-limit testing does not
// contaminate the deliberate cohort distribution in PRD-01 §5.3.
//
//   node scripts/cleanup-probe-orders.mjs

import { gql } from './lib/shopify.mjs';

const LIST = `
query ProbeOrders {
  orders(first: 100, query: "tag:cadence-probe") {
    edges { node { id name } }
  }
}`;

const found = gql(LIST).orders.edges.map(e => e.node);

if (!found.length) {
  console.log('No probe orders found — nothing to clean up.');
  process.exit(0);
}

console.log(`Deleting ${found.length} probe order(s): ${found.map(o => o.name).join(', ')}\n`);

// Alias every delete into one mutation — one round trip instead of N.
const mutation = `mutation DeleteProbes {
${found.map((o, i) => `  d${i}: orderDelete(orderId: "${o.id}") { deletedId userErrors { field message } }`).join('\n')}
}`;

const res = gql(mutation);
const deleted = Object.values(res).filter(r => r?.deletedId).length;
console.log(`✓ ${deleted}/${found.length} deleted`);

const remaining = gql(LIST).orders.edges.length;
console.log(remaining === 0
  ? '✓ store is clean — no probe orders remain'
  : `✗ ${remaining} still present`);
process.exit(remaining === 0 ? 0 : 1);
