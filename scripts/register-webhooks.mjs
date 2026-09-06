// Registers the seven PRD-01 §6.2 webhook topics against a live Cadence URL.
//
//   WEBHOOK_BASE_URL=https://your-app.vercel.app node --import tsx scripts/register-webhooks.mjs
//   node --import tsx scripts/register-webhooks.mjs --list
//   node --import tsx scripts/register-webhooks.mjs --delete-all
//
// Why this script exists: `shopify.app.toml` carries the subscriptions for the
// `shopify app dev` / `shopify app deploy` path, but that path needs the CLI
// tunnel, which fails under WARP on the campus network (build-plan Task 6). When
// Cadence runs on Vercel instead, the topics have to be pointed at the Vercel
// URL by hand — this does that, through the same `shopify app execute` route as
// every other seed script.
//
// The subscriptions are created under the `cadence-crm` app, so Shopify signs
// deliveries with that app's client secret. `SHOPIFY_API_SECRET` in .env.local
// (and in the Vercel project) MUST be that same secret or every delivery fails
// HMAC and lands in webhook_log with hmac_valid = false.
import { gql } from './lib/shopify.mjs';
import { SHOPIFY_WEBHOOK_TOPICS } from '../lib/shopify-webhook.ts';

const ARGS = new Set(process.argv.slice(2));
const LIST_ONLY = ARGS.has('--list');
const DELETE_ALL = ARGS.has('--delete-all');

const PATH = '/api/webhooks/shopify';

// 'orders/create' -> 'ORDERS_CREATE', the WebhookSubscriptionTopic enum spelling.
const topicEnum = (t) => t.replace(/[/-]/g, '_').toUpperCase();

const LIST = `
query {
  webhookSubscriptions(first: 100) {
    edges {
      node {
        id
        topic
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
    }
  }
}`;

const CREATE = `
mutation ($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id topic }
    userErrors { field message }
  }
}`;

const UPDATE = `
mutation ($id: ID!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
    webhookSubscription { id topic }
    userErrors { field message }
  }
}`;

const DELETE = `
mutation ($id: ID!) {
  webhookSubscriptionDelete(id: $id) {
    deletedWebhookSubscriptionId
    userErrors { field message }
  }
}`;

function current() {
  return gql(LIST).webhookSubscriptions.edges.map((e) => ({
    id: e.node.id,
    topic: e.node.topic,
    url: e.node.endpoint?.callbackUrl ?? `(${e.node.endpoint?.__typename})`,
  }));
}

const existing = current();

if (LIST_ONLY) {
  if (existing.length === 0) {
    console.log('No webhook subscriptions on this store.');
  } else {
    for (const s of existing) console.log(`  ${s.topic.padEnd(20)} → ${s.url}`);
  }
  process.exit(0);
}

if (DELETE_ALL) {
  for (const s of existing) {
    gql(DELETE, { id: s.id });
    console.log(`  ✗ deleted ${s.topic} → ${s.url}`);
  }
  console.log(`\n${existing.length} subscription(s) removed.`);
  process.exit(0);
}

const base = (process.env.WEBHOOK_BASE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
  console.error('Set WEBHOOK_BASE_URL to the https origin Cadence is reachable at, e.g.');
  console.error('  WEBHOOK_BASE_URL=https://cadence-crm.vercel.app node --import tsx scripts/register-webhooks.mjs');
  process.exit(1);
}
const callbackUrl = base + PATH;

console.log(`Target: ${callbackUrl}\n`);

let created = 0, updated = 0, ok = 0;

for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
  const ENUM = topicEnum(topic);
  const match = existing.find((s) => s.topic === ENUM);
  const sub = { callbackUrl, format: 'JSON' };

  if (match && match.url === callbackUrl) {
    console.log(`  · ${topic.padEnd(18)} already registered`);
    ok++;
  } else if (match) {
    gql(UPDATE, { id: match.id, sub });
    console.log(`  ↻ ${topic.padEnd(18)} repointed from ${match.url}`);
    updated++;
  } else {
    gql(CREATE, { topic: ENUM, sub });
    console.log(`  ✓ ${topic.padEnd(18)} created`);
    created++;
  }
}

console.log(`\n${created} created, ${updated} repointed, ${ok} unchanged.`);
console.log('Verify delivery: place an order, then check webhook_log (WARP on):');
console.log("  select topic, hmac_valid, error, received_at, processed_at from webhook_log order by received_at desc limit 5;");
