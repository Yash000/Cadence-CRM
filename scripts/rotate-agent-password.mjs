// Gives cadence_agent its OWN password, distinct from the postgres superuser's.
//
//   node scripts/rotate-agent-password.mjs
//
// The generated secret is written straight into .env.local and never printed,
// logged, or returned — so it does not end up in a transcript or shell history.
// Requires DATABASE_URL (postgres role) to already be present.

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const ENV = new URL('../.env.local', import.meta.url);
const raw = readFileSync(ENV, 'utf8');

const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

if (!env.DATABASE_URL) {
  console.error('DATABASE_URL missing from .env.local — add it first.');
  process.exit(1);
}

// Hex only: no characters that need escaping inside a connection URL.
const pw = randomBytes(24).toString('hex');

const admin = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await admin.connect();
await admin.query(`alter role cadence_agent with login password '${pw}'`);
await admin.end();
console.log('✓ cadence_agent password rotated (value not printed)');

// Rebuild AGENT_DATABASE_URL with the new secret, preserving host/port.
const oldUrl = env.AGENT_DATABASE_URL ?? '';
const m = oldUrl.match(/^postgresql:\/\/([^:]+):[^@]*@(.+)$/);
if (!m) {
  console.error('AGENT_DATABASE_URL missing or unparseable — cannot rewrite.');
  process.exit(1);
}
const newUrl = `postgresql://${m[1]}:${pw}@${m[2]}`;

const updated = raw.split(/\r?\n/)
  .map(l => (/^AGENT_DATABASE_URL=/.test(l) ? `AGENT_DATABASE_URL=${newUrl}` : l))
  .join('\n');
writeFileSync(ENV, updated, 'utf8');
console.log('✓ AGENT_DATABASE_URL updated in .env.local');

// Prove the new credential works and the isolation still holds.
const agent = new pg.Client({ connectionString: newUrl, ssl: { rejectUnauthorized: false } });
await agent.connect();
const { rows: [who] } = await agent.query(
  `select current_user, current_setting('default_transaction_read_only') ro`
);
let denied = false;
try { await agent.query('select 1 from customers limit 1'); }
catch { denied = true; }
await agent.end();

console.log(`✓ reconnected as ${who.current_user}, read_only=${who.ro}`);
console.log(denied
  ? '✓ base-table access still denied — isolation intact'
  : '✗ base tables READABLE — isolation broken, investigate');
process.exit(denied ? 0 : 1);
