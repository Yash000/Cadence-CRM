// Config for the `drizzle-kit` CLI (introspection/studio only).
//
// IMPORTANT: this project does not use drizzle-kit to manage the schema. The
// database in db/schema.ts already exists and is authoritative (see the header
// comment there) — do NOT run `drizzle-kit generate`, `push`, or `migrate`
// against it; there is no migrations/ directory wired into anything, and none
// should be created for this database. This config exists only so `drizzle-kit
// studio` or `drizzle-kit introspect` can be pointed at the live database when
// someone needs to eyeball it or diff it against schema.ts by hand.
import { defineConfig } from 'drizzle-kit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Minimal .env.local reader, matching scripts/verify-agent-role.mjs — split on
// /\r?\n/ because the file is CRLF and a bare \n split leaves stray \r's that
// break the `$` anchor in the regex below.
const envPath = fileURLToPath(new URL('./.env.local', import.meta.url));
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set in .env.local');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema.ts',
  out: './db/.introspect-scratch', // never committed; introspect/studio output only
  dbCredentials: { url: connectionString },
  strict: true,
  verbose: true,
});
