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
       // --path explicitly: when `shopify` is a wrapper/shim (e.g. the
       // shopify-ai-toolkit plugin), the `cwd` option below is not always
       // honoured and the CLI walks up from the drive root looking for
       // shopify.app.toml. Passing the app dir directly removes that guess.
       '--path', `"${APP_DIR}"`,
       '--query-file', `"${qFile}"`,
       '--variable-file', `"${vFile}"`],
      { cwd: APP_DIR, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    const blob = `${e.stdout || ''}${e.stderr || ''}`;
    // Same narrow-match discipline as below: a transport-level 429/THROTTLED
    // code is the only thing that should trigger a backoff retry here.
    if (/"code"\s*:\s*"THROTTLED"|HTTP 429|too many attempts\.?\s*please try again later/i.test(blob)) {
      const err = new Error(blob.replace(/\s+/g, ' ').slice(-400) || 'throttled');
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

  const err = classifyGqlResponse(data);
  if (err) throw err;

  return data;
}

// Literal phrase Shopify actually returns for orderCreate's per-minute
// business-logic cap — confirmed live: 22 real throttle events during the
// seed run, message verbatim "Too many attempts. Please try again later."
// every time. NOT one of OrderCreateUserErrorCode's declared enum values
// (INVALID, FULFILLMENT_SERVICE_INVALID, INVENTORY_CLAIM_FAILED,
// PROCESSED_AT_INVALID, TAX_LINE_RATE_MISSING, REDUNDANT_CUSTOMER_FIELDS,
// SHOP_DORMANT — checked via __type introspection against this store), so
// there is no structured code to key off for this specific userError.
// Match the literal observed phrase only — not loose single words
// ("exceeded", "too many") that also appear in ordinary validation errors
// ("maximum quantity exceeded", "too many line items") and would falsely
// retry-then-discard those for ~2.7 minutes before overwriting the real
// message with the generic string "THROTTLED".
export const THROTTLE_PHRASE_RE = /too many attempts\.?\s*please try again later/i;

/**
 * Inspect a parsed GraphQL response for a real error (top-level `errors[]`
 * or any mutation's `userErrors[]`) and classify it. Returns an Error with
 * `.throttled = true` (and the ORIGINAL message preserved, never replaced
 * with a generic "THROTTLED" string) if the store is genuinely rate
 * limiting; returns an ordinary Error for any other failure; returns null
 * if there is no error at all. Exported standalone (no network/CLI
 * dependency) so the classification logic is directly unit-testable.
 */
export function classifyGqlResponse(data) {
  if (data.errors?.length) {
    const msg = data.errors.map(e => e.message).join('; ');
    // Top-level GraphQL cost throttling has a documented structured shape:
    // errors: [{ message, extensions: { code: "THROTTLED" } }]. Prefer this
    // over text matching wherever it's present.
    const structuredThrottle = data.errors.some(e => e.extensions?.code === 'THROTTLED');
    const err = new Error(msg); // never discard the real text
    if (structuredThrottle || THROTTLE_PHRASE_RE.test(msg)) err.throttled = true;
    return err;
  }

  // Surface userErrors from any mutation payload rather than silently succeeding.
  for (const [field, payload] of Object.entries(data)) {
    const ue = payload?.userErrors;
    if (Array.isArray(ue) && ue.length) {
      const msg = `${field}: ${ue.map(u => `${(u.field || []).join('.')} ${u.message}`).join('; ')}`;
      const err = new Error(msg); // never discard the real text
      if (THROTTLE_PHRASE_RE.test(msg)) err.throttled = true;
      return err;
    }
  }

  return null;
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
