// One-off historical pull for orders that predate the webhook subscription
// (PRD-02 §F1.6). Webhooks only fire forward, so an order placed before
// scripts/register-webhooks.mjs ran — or while Cadence had no public URL —
// never reaches Postgres. This fetches orders straight from the Admin API and
// runs them through the SAME sync path a live `orders/create` delivery uses
// (lib/shopify-sync.processWebhook), so the result is byte-identical to having
// received the webhook.
//
//   # WARP on (Postgres), CLI authenticated (Shopify)
//   node --import tsx scripts/backfill-orders.mjs
//   node --import tsx scripts/backfill-orders.mjs --since 2026-09-01
//   node --import tsx scripts/backfill-orders.mjs --dry-run
//
// Idempotent: upserts key on shopify_order_id, so re-running converges on one
// row per order rather than duplicating.
import { readFileSync } from 'node:fs';
import { gql } from './lib/shopify.mjs';

// .env.local -> process.env, same minimal reader as the other scripts. Needed
// for DATABASE_URL before lib/shopify-sync.ts (via db/index.ts) is imported.
try {
  for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* optional */ }

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const sinceIdx = ARGS.indexOf('--since');
const SINCE = sinceIdx !== -1 ? ARGS[sinceIdx + 1] : null;

if (!process.env.DATABASE_URL && !DRY_RUN) {
  console.error('DATABASE_URL is not set (check .env.local). Connect WARP and retry.');
  process.exit(1);
}

// gid://shopify/Order/1234567890 -> 1234567890
const num = (gid) => {
  const n = Number(String(gid).split('/').pop());
  return Number.isSafeInteger(n) ? n : null;
};
const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

const QUERY = `
query ($cursor: String, $q: String) {
  orders(first: 50, after: $cursor, query: $q, sortKey: PROCESSED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      processedAt
      createdAt
      cancelledAt
      email
      displayFinancialStatus
      discountCodes
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      currentSubtotalPriceSet { shopMoney { amount } }
      totalDiscountsSet { shopMoney { amount } }
      customer {
        id
        email
        phone
        firstName
        lastName
        emailMarketingConsent { marketingState }
        smsMarketingConsent { marketingState }
        defaultAddress { city province country phone }
      }
      lineItems(first: 100) {
        nodes {
          title
          quantity
          originalUnitPriceSet { shopMoney { amount } }
          product { id }
          variant { id }
        }
      }
    }
  }
}`;

/** GraphQL Order node -> the REST/webhook JSON shape buildOrderInput expects. */
function toWebhookPayload(o) {
  const c = o.customer;
  return {
    id: num(o.id),
    name: o.name,
    processed_at: o.processedAt,
    created_at: o.createdAt,
    cancelled_at: o.cancelledAt,
    email: o.email,
    financial_status: lower(o.displayFinancialStatus),
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode,
    total_price: o.currentTotalPriceSet?.shopMoney?.amount,
    subtotal_price: o.currentSubtotalPriceSet?.shopMoney?.amount,
    total_discounts: o.totalDiscountsSet?.shopMoney?.amount,
    discount_codes: Array.isArray(o.discountCodes) ? o.discountCodes : [],
    customer: c
      ? {
          id: num(c.id),
          email: c.email,
          phone: c.phone,
          first_name: c.firstName,
          last_name: c.lastName,
          email_marketing_consent: c.emailMarketingConsent
            ? { state: lower(c.emailMarketingConsent.marketingState) }
            : null,
          sms_marketing_consent: c.smsMarketingConsent
            ? { state: lower(c.smsMarketingConsent.marketingState) }
            : null,
          default_address: c.defaultAddress
            ? {
                city: c.defaultAddress.city,
                province: c.defaultAddress.province,
                country: c.defaultAddress.country,
                phone: c.defaultAddress.phone,
              }
            : null,
        }
      : null,
    line_items: (o.lineItems?.nodes ?? []).map((li) => ({
      title: li.title,
      quantity: li.quantity,
      price: li.originalUnitPriceSet?.shopMoney?.amount,
      product_id: li.product ? num(li.product.id) : null,
      variant_id: li.variant ? num(li.variant.id) : null,
    })),
  };
}

// Collect every order first (sync CLI calls), then process — keeps the Shopify
// read and the Postgres write phases separate and legible in the log.
const orders = [];
let cursor = null;
const q = SINCE ? `processed_at:>=${SINCE}` : null;
do {
  const page = gql(QUERY, { cursor, q }).orders;
  orders.push(...page.nodes);
  cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  process.stdout.write(`\r  fetched ${orders.length} order(s)…`);
} while (cursor);
console.log();

if (orders.length === 0) {
  console.log('No orders match. Nothing to backfill.');
  process.exit(0);
}

if (DRY_RUN) {
  for (const o of orders) {
    const p = toWebhookPayload(o);
    console.log(
      `  ${String(p.name).padEnd(8)} ${p.processed_at?.slice(0, 10)}  ` +
        `${p.currency} ${p.total_price}  ${p.line_items.length} line(s)  ` +
        `${p.customer?.email ?? p.email ?? 'no email'}`,
    );
  }
  console.log(`\n--dry-run: ${orders.length} order(s) would be synced. No DB writes.`);
  process.exit(0);
}

const { processWebhook } = await import('../lib/shopify-sync.ts');

let ok = 0;
let failed = 0;
for (const o of orders) {
  const payload = toWebhookPayload(o);
  try {
    const topic = payload.cancelled_at ? 'orders/cancelled' : 'orders/create';
    await processWebhook(topic, payload);
    console.log(`  ✓ ${payload.name}`);
    ok++;
  } catch (err) {
    console.log(`  ✗ ${payload.name} — ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${ok} synced, ${failed} failed.`);
console.log('Re-run scripts/recompute-scores.mjs (npm run score) so the new orders affect segments.');
process.exit(failed === 0 ? 0 : 1);
