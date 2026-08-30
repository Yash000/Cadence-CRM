// Database tests for the storefront event tracking endpoint (PRD-01 §7,
// task-9-brief.md) — that a valid payload's row actually lands in `events`,
// and that customer_id resolution behaves as documented.
//
// Runs against the real Postgres in DATABASE_URL, same reasoning as
// tests/shopify-webhook-db.test.ts: this is exercising a real INSERT and a
// real lookup against customers.shopify_customer_id, not a mock agreeing
// with itself.
//
// SAFETY: every row this suite creates carries session_id
// 'cadence-events-test-<run>' (reserved prefix; the seed never generates
// one) or is tied to a customer created here with shopify_customer_id in the
// 9900000000-901..903 range (disjoint from tests/shopify-webhook-db.test.ts's
// 9900000000201-203 range and from live seed ids). cleanup() removes exactly
// that namespace, before and after, so a crashed run leaves nothing behind.
//
// Skipped with a message rather than failing if DATABASE_URL is unavailable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after as afterAll, before, describe, it } from 'node:test';

// MUST come before ../db/index, which reads DATABASE_URL at import time.
import { HAS_DATABASE_URL } from './env';

import { eq, like } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { parseEventInput } from '../lib/events';
import { getRecentEvents, insertEvent, resolveCustomerId } from '../lib/events-db';

const { customers, events } = schema;

const RUN_ID = randomUUID().slice(0, 8);
const SESSION_PREFIX = `cadence-events-test-${RUN_ID}`;
const TEST_SHOPIFY_CUSTOMER_IDS = [9900000000901, 9900000000902, 9900000000903];

function sessionId(label: string): string {
  return `${SESSION_PREFIX}-${label}`;
}

async function cleanup(): Promise<void> {
  await db.delete(events).where(like(events.sessionId, `${SESSION_PREFIX}%`));
  await db.delete(customers).where(
    // one at a time — Drizzle's inArray needs an import, and three OR'd
    // eq()s is no less clear here
    eq(customers.shopifyCustomerId, TEST_SHOPIFY_CUSTOMER_IDS[0]),
  );
  for (const id of TEST_SHOPIFY_CUSTOMER_IDS.slice(1)) {
    await db.delete(customers).where(eq(customers.shopifyCustomerId, id));
  }
}

describe(
  'events endpoint against Postgres',
  { skip: HAS_DATABASE_URL ? false : 'DATABASE_URL not set' },
  () => {
    before(cleanup);
    afterAll(cleanup);

    it('resolveCustomerId returns null for an unknown/absent shopify customer id', async () => {
      assert.equal(await resolveCustomerId(null), null);
      assert.equal(await resolveCustomerId(TEST_SHOPIFY_CUSTOMER_IDS[0]), null); // not yet inserted
    });

    it('a valid payload is inserted and lands in `events` with the source stamped', async () => {
      const parsed = parseEventInput(
        {
          type: 'page_view',
          session_id: sessionId('page-view'),
          payload: { template: 'index', url: 'https://rasaya-dev.myshopify.com/' },
        },
        'storefront_pixel',
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const inserted = await insertEvent(parsed.value);
      assert.ok(inserted.id);
      assert.equal(inserted.customerId, null); // no customer_id was sent

      const [row] = await db.select().from(events).where(eq(events.id, inserted.id)).limit(1);
      assert.ok(row, 'row should exist in events');
      assert.equal(row.type, 'page_view');
      assert.equal(row.sessionId, sessionId('page-view'));
      assert.equal(row.customerId, null);
      const payload = row.payload as Record<string, unknown>;
      assert.equal(payload.template, 'index');
      // stamped by lib/events-db.ts insertEvent, not sent by the caller
      assert.equal(payload.source, 'storefront_pixel');
    });

    it('resolves customer_id to the matching internal customers.id when the shopify customer exists', async () => {
      const [row] = await db
        .insert(customers)
        .values({
          shopifyCustomerId: TEST_SHOPIFY_CUSTOMER_IDS[0],
          firstName: 'Events',
          lastName: 'Test',
        })
        .returning({ id: customers.id });

      const resolved = await resolveCustomerId(TEST_SHOPIFY_CUSTOMER_IDS[0]);
      assert.equal(resolved, row.id);

      const parsed = parseEventInput(
        {
          type: 'product_view',
          customer_id: TEST_SHOPIFY_CUSTOMER_IDS[0],
          session_id: sessionId('product-view'),
          payload: { id: 'gid://shopify/Product/1', title: 'Rosemary Scalp Serum' },
        },
        'storefront_pixel',
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const inserted = await insertEvent(parsed.value);
      assert.equal(inserted.customerId, row.id);
    });

    it('a customer_id with no matching shopify customer resolves to null rather than failing', async () => {
      const parsed = parseEventInput(
        { type: 'add_to_cart', customer_id: 9900000000999, session_id: sessionId('unknown-customer') },
        'storefront_pixel',
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;

      const inserted = await insertEvent(parsed.value);
      assert.equal(inserted.customerId, null);
    });

    it('getRecentEvents surfaces a just-inserted row, newest first', async () => {
      const parsed = parseEventInput(
        { type: 'checkout_started', session_id: sessionId('checkout') },
        'simulator',
      );
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      const inserted = await insertEvent(parsed.value);

      const recent = await getRecentEvents(50);
      const found = recent.find((e) => e.id === inserted.id);
      assert.ok(found, 'just-inserted event should appear in getRecentEvents');
      assert.equal(found?.type, 'checkout_started');
      assert.ok(recent.length <= 50);
    });
  },
);
