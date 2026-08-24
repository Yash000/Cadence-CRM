// Loads .env.local for tests that need DATABASE_URL / SHOPIFY_API_SECRET.
//
// Imported FIRST by those test files, before ../db/index — that module reads
// DATABASE_URL at import time and throws if it is unset. Import order is
// evaluation order in both ESM and CJS, so a plain side-effect import is
// enough; it does not need top-level await.
//
// .env.local is owned by the controller. This only reads it, never writes it.
// Same minimal reader as scripts/recompute-scores.mjs (split on /\r?\n/ so a
// CRLF file does not leave a trailing \r inside the value).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env.local', import.meta.url));

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
}

export const HAS_DATABASE_URL = Boolean(process.env.DATABASE_URL);
export const HAS_SHOPIFY_SECRET = Boolean(process.env.SHOPIFY_API_SECRET);
