// Remove Task 6 test deliveries from webhook_log.
//
//   node --import tsx scripts/purge-webhook-test-log.mjs
//
// The webhook tests clean up after themselves; this exists for the case where
// a run was interrupted, and as the one-shot that cleared rows left by test
// runs made before cleanup() learned to cover them. webhook_log is what §F1.7's
// sync health page reads, so test deliveries do not belong in it.
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { db } = await import('../db/index.ts');
const { sql } = await import('drizzle-orm');

const deleted = await db.execute(sql`
  delete from webhook_log
   where topic like 'test/%'
      or shopify_id in ('9900000000101', '9900000000901',
                        '9900000000201', '9900000000202', '9900000000203')
      or payload->>'_raw' like '%cadence-webhook-test.invalid%'
  returning id
`);

console.log(`deleted ${deleted.rows.length} test webhook_log row(s)`);
process.exit(0);
