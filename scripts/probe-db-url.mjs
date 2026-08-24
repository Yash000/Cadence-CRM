// Throwaway: does the supplied password authenticate the `postgres` role?
// Determines whether DATABASE_URL can be built without asking again.
import pg from 'pg';

const REF = 'pldjtgzmwtgrlyygslvl';
const PW = process.argv[2];
const HOST = 'aws-0-ap-southeast-1.pooler.supabase.com';

for (const [label, url] of [
  ['postgres @ pooler 6543', `postgresql://postgres.${REF}:${PW}@${HOST}:6543/postgres`],
  ['postgres @ pooler 5432', `postgresql://postgres.${REF}:${PW}@${HOST}:5432/postgres`],
]) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const { rows: [r] } = await c.query('select current_user, (select count(*) from customers) as customers');
    console.log(`OK   ${label}  user=${r.current_user}  customers=${r.customers}`);
    await c.end();
  } catch (e) {
    console.log(`FAIL ${label}  ${e.message.split('\n')[0]}`);
    try { await c.end(); } catch {}
  }
}
