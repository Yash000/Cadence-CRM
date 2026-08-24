// Drizzle client for the Cadence CRM app/server side. Reads DATABASE_URL —
// the `postgres` superuser role via the Supabase session pooler (port 6543).
//
// NEVER use AGENT_DATABASE_URL here: that role is a deliberately crippled
// read-only account for the AI SQL agent (PRD-02 §F4.3), scoped to four views
// with a 5s statement_timeout. Widening it, or routing app traffic through it,
// defeats the isolation scripts/verify-agent-role.mjs exists to prove.
//
// Uses the `pg` driver (already a project dependency, and the same driver
// scripts/verify-agent-role.mjs and scripts/probe-db-url.mjs already use) via
// drizzle-orm/node-postgres, rather than adding the `postgres` package as a
// second Postgres client for no functional gain.
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. It must be present in .env.local (session pooler, ' +
      'port 6543, `postgres` user) and loaded into process.env before this module ' +
      'is imported — see scripts/verify-agent-role.mjs for the .env.local loader ' +
      'pattern used elsewhere in this repo.',
  );
}

// A pooled client, not a single Client: the app will have concurrent request
// handlers, and Supabase's own pooler sits in front of this anyway (session
// mode on 6543), so this pool is deliberately small.
const pool = new pg.Pool({ connectionString, max: 10 });

export const db = drizzle(pool, { schema });
export { schema };
