// Applies db/views-room.sql to the database in DATABASE_URL.
//
//   npm run apply-room-view
//   npm run apply-room-view -- --dry-run   # EXPLAIN only, creates nothing
//
// The file is CREATE OR REPLACE VIEW plus an idempotent GRANT, so re-running is
// safe and creates no tables. It is a separate script rather than part of the
// seed because a view definition is code, not data: it should be applied when
// the definition changes, not every time the store is re-seeded.
//
// Same minimal .env.local reader as scripts/seed-supabase.mjs — split on
// /\r?\n/ so a CRLF file does not leave a trailing \r inside the value.
import { readFileSync } from 'node:fs';
import pg from 'pg';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const DRY_RUN = process.argv.includes('--dry-run');
const sql = readFileSync(new URL('../db/views-room.sql', import.meta.url), 'utf8');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set in .env.local.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  if (DRY_RUN) {
    // Plan the SELECT body without creating anything. Strips the CREATE OR
    // REPLACE header and the trailing GRANT so what is left is a bare query.
    const body = sql
      .replace(/^[\s\S]*?create\s+or\s+replace\s+view\s+v_room_completion\s+as/i, '')
      .replace(/grant\s+select[\s\S]*$/i, '')
      .trim()
      .replace(/;\s*$/, '');
    const plan = await client.query('explain ' + body);
    console.log('✓ EXPLAIN OK — the planner accepted the view body. Nothing was created.');
    console.log(`  ${plan.rows.length} plan rows | top node: ${plan.rows[0]['QUERY PLAN']}`);
  } else {
    await client.query(sql);
    console.log('✓ v_room_completion created/replaced, and granted to cadence_agent.');

    const shape = await client.query(
      `select count(*)::int as rows,
              count(distinct customer_id)::int as customers,
              count(distinct room)::int as rooms,
              count(*) filter (where completion_pct = 100)::int as complete,
              count(*) filter (where next_best_title is not null)::int as with_a_suggestion
       from v_room_completion`,
    );
    const s = shape.rows[0];
    console.log(
      `  ${s.rows} rows · ${s.customers} customers · ${s.rooms} rooms · ` +
      `${s.complete} complete · ${s.with_a_suggestion} carry a next-best suggestion`,
    );
    if (s.rows === 0) {
      console.log(
        '  NOTE: zero rows. Expected until the store is re-seeded with the HomeStyle\n' +
        '        catalogue — the view reads products.collection in (living-room,\n' +
        '        bedroom, dining), which the previous catalogue had none of.',
      );
    }
  }
} catch (e) {
  console.error('✗ failed:', e.message);
  if (e.position) {
    const at = Number(e.position);
    console.error('  near:', sql.slice(Math.max(0, at - 100), at + 60).replace(/\s+/g, ' '));
  }
  process.exitCode = 1;
} finally {
  await client.end();
}
