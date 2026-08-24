// One-off check that the Task 6 webhook tests left nothing behind in Postgres.
//
//   node --import tsx scripts/check-webhook-test-residue.mjs
//
// The tests reserve a namespace (Shopify ids 9900000000xxx, phones
// +91 99000 00xxx, emails @cadence-webhook-test.invalid) and clean it up in
// before/after hooks. This asserts that independently, from a fresh process.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { db } = await import('../db/index.ts');
const { sql } = await import('drizzle-orm');

const rows = await db.execute(sql`
  select
    (select count(*) from customers
       where shopify_customer_id between 9900000000200 and 9900000000299
          or phone_e164 like '+91990000%'
          or email::text like '%@cadence-webhook-test.invalid')            as test_customers,
    (select count(*) from orders where shopify_order_id = 9900000000101)   as test_orders,
    (select count(*) from events
       where payload->>'checkout_id' = '9900000000901')                    as test_events,
    (select count(*) from webhook_log
       where topic like 'test/%'
          or shopify_id in ('9900000000101', '9900000000901',
                            '9900000000201', '9900000000202', '9900000000203')
          or payload->>'_raw' like '%cadence-webhook-test.invalid%')       as test_webhook_logs,
    (select count(*) from customers)                                       as all_customers,
    (select count(*) from orders)                                          as all_orders,
    (select count(*) from webhook_log)                                     as all_webhook_logs
`);

const r = rows.rows[0];
console.log('residue in the test namespace:');
console.log(`  customers   ${r.test_customers}`);
console.log(`  orders      ${r.test_orders}`);
console.log(`  events      ${r.test_events}`);
console.log(`  webhook_log ${r.test_webhook_logs}`);
console.log('live totals (unchanged by the tests):');
console.log(`  customers   ${r.all_customers}`);
console.log(`  orders      ${r.all_orders}`);
console.log(`  webhook_log ${r.all_webhook_logs}`);

const dirty =
  Number(r.test_customers) + Number(r.test_orders) + Number(r.test_events) + Number(r.test_webhook_logs);
process.exit(dirty === 0 ? 0 : 1);
