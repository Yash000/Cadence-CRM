// Throwaway: finds which Supabase host accepts the cadence_agent login.
import pg from 'pg';

const REF = 'pldjtgzmwtgrlyygslvl';
const PW = process.argv[2];
const REGION = 'ap-southeast-1';

const candidates = [
  ['aws-0 :6543 tx',   `postgresql://cadence_agent.${REF}:${PW}@aws-0-${REGION}.pooler.supabase.com:6543/postgres`],
  ['aws-0 :5432 sess', `postgresql://cadence_agent.${REF}:${PW}@aws-0-${REGION}.pooler.supabase.com:5432/postgres`],
  ['aws-1 :6543 tx',   `postgresql://cadence_agent.${REF}:${PW}@aws-1-${REGION}.pooler.supabase.com:6543/postgres`],
  ['aws-1 :5432 sess', `postgresql://cadence_agent.${REF}:${PW}@aws-1-${REGION}.pooler.supabase.com:5432/postgres`],
];

for (const [label, url] of candidates) {
  const c = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await c.connect();
    const { rows: [r] } = await c.query(
      `select current_user, current_setting('statement_timeout') t,
              current_setting('default_transaction_read_only') ro`
    );
    console.log(`OK   ${label.padEnd(18)} user=${r.current_user} timeout=${r.t} read_only=${r.ro}`);
    await c.end();
  } catch (e) {
    const bits = [e.code, e.severity, e.routine, JSON.stringify(e.message)].filter(Boolean);
    console.log(`FAIL ${label.padEnd(18)} ${bits.join(' | ')}`);
    try { await c.end(); } catch {}
  }
}
