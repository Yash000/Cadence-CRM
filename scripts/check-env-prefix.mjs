// Prints the credential *type* of each SHOPIFY_* var without revealing values.
import { readFileSync } from 'node:fs';

const KNOWN = {
  shpat_: 'Admin API access token  <-- this is the one we need',
  shpss_: 'API secret key (wrong — this is the app secret, not the token)',
  shpca_: 'custom app client credential (wrong)',
  shpsa_: 'Storefront API token (wrong)',
  shppa_: 'partner/private app token',
};

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  const key = m[1];
  const val = m[2].trim().replace(/^["']|["']$/g, '');
  if (!key.startsWith('SHOPIFY')) continue;

  const pre = val.includes('_') ? val.slice(0, val.indexOf('_') + 1) : null;
  const isHex = /^[0-9a-fA-F]+$/.test(val);
  const note = pre
    ? (KNOWN[pre] ?? 'unrecognised prefix')
    : isHex
      ? 'plain hex — likely the API key (Client ID), not the access token'
      : 'no prefix';

  console.log(`${key.padEnd(24)} prefix=${(pre ?? '(none)').padEnd(8)} len=${String(val.length).padEnd(4)} ${note}`);
}
