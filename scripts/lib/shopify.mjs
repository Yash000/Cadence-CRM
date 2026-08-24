// Thin wrapper around `shopify app execute`, which is currently the only route
// to an OFFLINE access token — and orderCreate accepts nothing else
// (PRD-02 §6.1). Requires the app installed on a *development* store.
//
// Two Windows landmines are handled here so callers never see them:
//  1. `shopify` is a .cmd shim, so it cannot spawn with shell:false.
//  2. With shell:true, cmd.exe re-splits argv — and this project's path has a
//     space in it — so every path argument must be explicitly quoted.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(HERE, '..', '..', 'shopify-app', 'cadence-crm');
export const GQL_DIR = join(HERE, '..', 'gql');
export const STORE = process.env.SHOPIFY_DEV_STORE ?? 'rasaya-dev.myshopify.com';

mkdirSync(GQL_DIR, { recursive: true });

let seq = 0;

/**
 * Run a GraphQL operation and return the parsed `data` object.
 * Throws on transport failure, GraphQL errors, or any non-empty userErrors.
 */
export function gql(query, variables = {}) {
  const id = `.tmp-${process.pid}-${seq++}`;
  const qFile = join(GQL_DIR, `${id}.graphql`);
  const vFile = join(GQL_DIR, `${id}.json`);
  writeFileSync(qFile, query);
  writeFileSync(vFile, JSON.stringify(variables));

  let raw;
  try {
    raw = execFileSync(
      'shopify',
      ['app', 'execute', '--store', STORE,
       '--query-file', `"${qFile}"`,
       '--variable-file', `"${vFile}"`],
      { cwd: APP_DIR, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    const blob = `${e.stdout || ''}${e.stderr || ''}`;
    if (/THROTTLED|exceeded|rate limit|too many/i.test(blob)) {
      const err = new Error('THROTTLED');
      err.throttled = true;
      throw err;
    }
    throw new Error(blob.replace(/\s+/g, ' ').slice(-400) || e.message);
  }

  // The CLI prints a success banner before the JSON body; take from the first brace.
  const start = raw.indexOf('{');
  if (start === -1) throw new Error(`no JSON in response: ${raw.slice(-300)}`);
  let data;
  try {
    data = JSON.parse(raw.slice(start));
  } catch {
    throw new Error(`unparseable response: ${raw.slice(start, start + 300)}`);
  }

  const THROTTLE_RE = /THROTTLED|exceeded|rate limit|too many|too many attempts|try again later/i;

  if (data.errors?.length) {
    const msg = data.errors.map(e => e.message).join('; ');
    if (THROTTLE_RE.test(msg)) {
      const err = new Error('THROTTLED');
      err.throttled = true;
      throw err;
    }
    throw new Error(msg);
  }

  // Surface userErrors from any mutation payload rather than silently succeeding.
  // NOTE: Shopify reports the per-minute order-create cap as a normal 200 response
  // with a userErrors entry ("Too many attempts. Please try again later."), not as
  // a transport-level failure — so this path must also be checked for throttling,
  // or gqlWithBackoff never sees `.throttled` and the run dies at the first cap hit.
  for (const [field, payload] of Object.entries(data)) {
    const ue = payload?.userErrors;
    if (Array.isArray(ue) && ue.length) {
      const msg = `${field}: ${ue.map(u => `${(u.field || []).join('.')} ${u.message}`).join('; ')}`;
      if (THROTTLE_RE.test(msg)) {
        const err = new Error('THROTTLED');
        err.throttled = true;
        throw err;
      }
      throw new Error(msg);
    }
  }

  return data;
}

/** Retry wrapper for the 5 orders/min cap measured on dev stores (PRD-01 §5.1). */
export async function gqlWithBackoff(query, variables = {}, { tries = 8, waitMs = 20000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return gql(query, variables);
    } catch (e) {
      if (!e.throttled || attempt >= tries) throw e;
      process.stdout.write(`  throttled, waiting ${waitMs / 1000}s… `);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}
