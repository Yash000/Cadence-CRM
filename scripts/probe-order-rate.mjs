// Measures the real orderCreate throughput on the dev store.
//
//   node scripts/probe-order-rate.mjs [count]
//
// PRD-01 §5.1 assumes 5 orders/min on dev and trial stores. That number drives
// the whole hybrid seeding split, so it is worth measuring rather than assuming.
// Orders are tagged `cadence-probe` so cleanup-probe-orders.mjs can find them.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, '..', 'shopify-app', 'cadence-crm');
const STORE = 'rasaya-dev.myshopify.com';
const SHOPIFY = process.env.SHOPIFY_CLI
  ?? 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\nodejs\\shopify.cmd';
const COUNT = Number(process.argv[2] || 8);
const TMP = join(HERE, 'gql', '.probe-tmp.json');

mkdirSync(join(HERE, 'gql'), { recursive: true });

const results = [];
const t0 = Date.now();

for (let i = 1; i <= COUNT; i++) {
  const vars = {
    order: {
      currency: 'INR',
      // Spread across 18 months so the probe also exercises backdating.
      processedAt: new Date(Date.UTC(2025, 2 + i, 10, 9, 0, 0)).toISOString(),
      financialStatus: 'PAID',
      tags: ['cadence-probe'],
      email: `probe${i}@cadence-test.invalid`,
      phone: `+9190000000${String(i).padStart(2, '0')}`,
      lineItems: [{
        title: `Probe Item ${i}`,
        quantity: 1,
        requiresShipping: true,
        priceSet: { shopMoney: { amount: '499.00', currencyCode: 'INR' } },
      }],
    },
  };
  writeFileSync(TMP, JSON.stringify(vars));

  const started = Date.now();
  let status, detail = '';
  try {
    // `shopify` is a .cmd shim, so it needs shell:true — but cmd.exe then
    // re-splits argv, and this project's path contains a space. Hence the
    // explicit quotes around each path.
    const out = execFileSync(
      'shopify',
      ['app', 'execute', '--store', STORE,
       '--query-file', `"${join(HERE, 'gql', 'order-create.graphql')}"`,
       '--variable-file', `"${TMP}"`],
      { cwd: APP_DIR, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (/THROTTLED|exceeded|rate limit|too many/i.test(out)) { status = 'THROTTLED'; detail = 'throttle in response'; }
    else if (/"name":\s*"#\d+"/.test(out)) status = 'OK';
    else { status = 'UNKNOWN'; detail = out.slice(-160).replace(/\s+/g, ' '); }
  } catch (e) {
    const blob = `${e.stdout || ''}${e.stderr || ''}`;
    status = /THROTTLED|exceeded|rate limit|too many/i.test(blob) ? 'THROTTLED' : 'ERROR';
    detail = blob.slice(-160).replace(/\s+/g, ' ');
  }
  const secs = (Date.now() - started) / 1000;
  results.push({ i, status, secs });
  console.log(`${String(i).padStart(2)}  ${status.padEnd(10)} ${secs.toFixed(1)}s  ${detail}`);
}

const total = (Date.now() - t0) / 1000;
const ok = results.filter(r => r.status === 'OK').length;
const throttled = results.filter(r => r.status === 'THROTTLED').length;

console.log(`\n${ok}/${COUNT} succeeded, ${throttled} throttled, ${total.toFixed(1)}s total`);
console.log(`observed rate: ${(ok / (total / 60)).toFixed(1)} orders/min`);
console.log(
  throttled > 0
    ? '\n→ Rate cap IS enforced. PRD-01 §5.1 holds; budget accordingly.'
    : `\n→ No throttling seen. Wall-clock is CLI overhead (~${(total / COUNT).toFixed(1)}s/order),`
      + '\n  not a Shopify cap — a direct HTTP client would be far faster.'
);
