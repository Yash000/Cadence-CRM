// Verifies the AI agent's database isolation (PRD-02 §F4.3).
//
//   npm i pg dotenv
//   node scripts/verify-agent-role.mjs
//
// Connects as cadence_agent using AGENT_DATABASE_URL and asserts that the
// permitted things work and the forbidden things fail. A prompt injection
// telling the model to "drop the customers table" should die here, at the
// database, not in application code.

import pg from 'pg';
import { readFileSync } from 'node:fs';

// Minimal .env.local reader — avoids a dotenv dependency for a one-off script.
// split on /\r?\n/ — on CRLF files a trailing \r is a JS regex line terminator,
// so `(.*)$` below would never match.
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const url = process.env.AGENT_DATABASE_URL;
if (!url) {
  console.error('AGENT_DATABASE_URL is not set in .env.local');
  process.exit(1);
}

if (/\/\/postgres[.:]/.test(url)) {
  console.error('AGENT_DATABASE_URL still uses the `postgres` user.');
  console.error('It must connect as cadence_agent, or none of this is enforced.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });

// [label, sql, mustSucceed]
const CHECKS = [
  ['read v_customer_360',        'select count(*) from v_customer_360',         true],
  ['read v_order_facts',         'select count(*) from v_order_facts',          true],
  ['read v_customer_scores',     'select count(*) from v_customer_scores',      true],
  ['read v_conversation_summary','select count(*) from v_conversation_summary', true],

  ['BLOCK read customers',   'select * from customers limit 1',                 false],
  ['BLOCK read orders',      'select * from orders limit 1',                    false],
  ['BLOCK read messages',    'select * from messages limit 1',                  false],
  ['BLOCK read ai_logs',     'select * from ai_logs limit 1',                   false],
  ['BLOCK read consents',    'select * from consents limit 1',                  false],
  ['BLOCK read auth.users',  'select * from auth.users limit 1',                false],

  ['BLOCK insert', "insert into segments (name) values ('pwned')",              false],
  ['BLOCK update', 'update customers set city = null',                          false],
  ['BLOCK delete', 'delete from customers',                                     false],
  ['BLOCK drop',   'drop table customers',                                      false],
  ['BLOCK ddl',    'create table exfil (id int)',                               false],
];

let failures = 0;

await client.connect();

// Role-level settings are applied on connect; confirm they survived the pooler.
const { rows: [cfg] } = await client.query(
  `select current_user, current_setting('statement_timeout') as timeout,
          current_setting('default_transaction_read_only') as read_only`
);

console.log(`\nconnected as : ${cfg.current_user}`);
console.log(`statement_timeout    : ${cfg.timeout}`);
console.log(`transaction_read_only: ${cfg.read_only}\n`);

if (cfg.current_user !== 'cadence_agent') {
  console.error(`✗ connected as "${cfg.current_user}", expected "cadence_agent"`);
  failures++;
}
// Transaction-mode pooling reuses connections; if either guardrail is missing,
// switch the port from 6543 to 5432 (session mode) and re-run.
if (cfg.timeout !== '5s')    { console.error('✗ statement_timeout is not 5s'); failures++; }
if (cfg.read_only !== 'on')  { console.error('✗ default_transaction_read_only is not on'); failures++; }

for (const [label, sql, mustSucceed] of CHECKS) {
  let ok, detail;
  try {
    await client.query(sql);
    ok = mustSucceed;
    detail = 'succeeded';
  } catch (err) {
    ok = !mustSucceed;
    detail = err.message.split('\n')[0];
  }
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} ${ok ? '' : `<-- ${detail}`}`);
}

await client.end();

console.log(
  failures === 0
    ? '\n✓ agent isolation holds — reads limited to the four views, all writes refused\n'
    : `\n✗ ${failures} check(s) failed — do NOT wire up the agent until these pass\n`
);
process.exit(failures === 0 ? 0 : 1);
