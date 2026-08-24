// Database tests for the Shopify webhook sync path (PRD-02 §F1.4, §F1.5).
//
//   npm test
//
// These run against the real Postgres in DATABASE_URL, on purpose. Idempotency
// here is a property of the UNIQUE constraints on `orders.shopify_order_id`
// and `customers.shopify_customer_id` plus ON CONFLICT — a mock would only
// test that the mock agrees with itself, and the whole claim being made is
// that the *database* refuses to create the second row. Same for identity
// resolution, which depends on the UNIQUE index on `customers.phone_e164`.
//
// SAFETY
// ------
// Every row these tests touch lives in a reserved namespace that the seed
// never generates:
//   - Shopify ids 9900000000xxx      (seed ids come from the live store)
//   - phones +91 99000 002xx         (seed phones are +91 70000 0xxxx)
//   - emails @cadence-webhook-test.invalid  (seed uses @cadence-seed.test)
// `cleanup()` deletes exactly that namespace, and runs both before and after
// the suite so a crashed run leaves nothing behind for the next one.
//
// Skipped with a message rather than failing if DATABASE_URL is unavailable —
// Postgres needs Cloudflare WARP connected on this machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after as afterAll, before, describe, it } from 'node:test';

// MUST come before ../db/index, which reads DATABASE_URL at import time.
import { HAS_DATABASE_URL } from './env';

import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { parsePayload, webhookLogPayload } from '../lib/shopify-webhook';
import { logWebhook, markWebhookProcessed, processWebhook } from '../lib/shopify-sync';

const { consents, customers, events, orderItems, orders, webhookLog } = schema;

const TEST_SHOPIFY_CUSTOMER_IDS = [9900000000201, 9900000000202, 9900000000203];
const TEST_SHOPIFY_ORDER_ID = 9900000000101;
const TEST_CHECKOUT_ID = '9900000000901';
const TEST_EMAIL_DOMAIN = '%@cadence-webhook-test.invalid';
const TEST_PHONE_PREFIX = '+91990000%';

function fixturePayload(name: string): Record<string, unknown> {
  const raw = readFileSync(fileURLToPath(new URL(`./fixtures/shopify/${name}`, import.meta.url)));
  const parsed = parsePayload(raw);
  assert.equal(parsed.ok, true, `${name} should parse`);
  return (parsed as { ok: true; value: Record<string, unknown> }).value;
}

async function cleanup(): Promise<void> {
  // orders.customer_id is ON DELETE SET NULL, so orders go before customers.
  // order_items and consents cascade from their parents.
  await db.delete(orders).where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
  await db.delete(events).where(sql`${events.payload}->>'checkout_id' = ${TEST_CHECKOUT_ID}`);
  await db
    .delete(customers)
    .where(
      or(
        inArray(customers.shopifyCustomerId, TEST_SHOPIFY_CUSTOMER_IDS),
        sql`${customers.email}::text like ${TEST_EMAIL_DOMAIN}`,
        like(customers.phoneE164, TEST_PHONE_PREFIX),
      ),
    );
  await db.delete(webhookLog).where(like(webhookLog.topic, 'test/%'));
}

async function countOrders(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
  return rows[0].n;
}

async function customerByPhone(phone: string) {
  const [row] = await db.select().from(customers).where(eq(customers.phoneE164, phone)).limit(1);
  return row;
}

describe('webhook sync against Postgres', { skip: HAS_DATABASE_URL ? false : 'DATABASE_URL not set' }, () => {
  before(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // §F1.4 — idempotent upsert
  // -------------------------------------------------------------------------

  it('applies the same orders/create twice and gets one order, not two', async () => {
    const payload = fixturePayload('orders-create.json');

    const first = await processWebhook('orders/create', payload);
    const second = await processWebhook('orders/create', payload);

    assert.equal(await countOrders(), 1, 'the UNIQUE constraint must absorb the retry');
    assert.equal(first.orderId, second.orderId, 'the retry must land on the same row');

    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    assert.equal(row.total, '1708.00');
    assert.equal(row.subtotal, '1898.00');
    assert.equal(row.discountTotal, '190.00');
    assert.deepEqual(row.discountCodes, ['RASAYA10']);
    assert.equal(row.financialStatus, 'paid');
    assert.equal(row.cancelledAt, null);
    assert.equal(row.processedAt.toISOString(), '2026-08-24T08:42:07.000Z');

    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, row.id));
    assert.equal(lines.length, 3, 'three lines, not six — the retry replaced them, it did not append');
    assert.equal(
      lines.filter((l) => l.productId !== null).length,
      3,
      'all three line items resolve to catalogue products by shopify_product_id',
    );
  });

  it('links the order to exactly one customer, created once', async () => {
    const rows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.shopifyCustomerId, 9900000000201));
    assert.equal(rows.length, 1);

    const [order] = await db
      .select({ customerId: orders.customerId })
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    assert.equal(order.customerId, rows[0].id);
  });

  it('applies orders/updated to the same row rather than inserting another', async () => {
    await processWebhook('orders/updated', fixturePayload('orders-updated.json'));

    assert.equal(await countOrders(), 1);
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    assert.equal(row.total, '1169.00');
    assert.equal(row.financialStatus, 'partially_refunded');

    const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, row.id));
    assert.equal(lines.length, 1, 'the two removed lines are gone, not orphaned');
    assert.equal(lines[0].qty, 1);
    assert.equal(lines[0].price, '1299.00');
  });

  it('applies orders/cancelled to the same row', async () => {
    await processWebhook('orders/cancelled', fixturePayload('orders-cancelled.json'));

    assert.equal(await countOrders(), 1);
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    assert.equal(row.cancelledAt?.toISOString(), '2026-08-25T04:33:44.000Z');
    assert.equal(row.financialStatus, 'refunded');
    assert.equal(row.total, '0.00');
  });

  // -------------------------------------------------------------------------
  // §F1.5 — identity resolution: phone first, then email
  // -------------------------------------------------------------------------

  it('resolves an inbound record onto an existing customer by phone, not by creating a second row', async () => {
    await cleanup();

    // A customer who already exists in the CRM: right phone, DIFFERENT email,
    // and no Shopify id at all — the shape a bulk-seeded or WhatsApp-sourced
    // contact has before Shopify ever sees them.
    const [existing] = await db
      .insert(customers)
      .values({
        phoneE164: '+919900000201',
        email: 'older.address@cadence-webhook-test.invalid',
        firstName: 'Ananya',
        city: 'Coimbatore',
      })
      .returning({ id: customers.id });

    // The webhook's phone is formatted differently ("+91 99000 00201") and its
    // email does not match. Phone is the key, so this must be the same person.
    const result = await processWebhook('orders/create', fixturePayload('orders-create.json'));
    assert.ok(result.orderId);

    const stitched = await customerByPhone('+919900000201');
    assert.equal(stitched.id, existing.id, 'matched on phone — no second customer row');
    assert.equal(
      stitched.shopifyCustomerId,
      9900000000201,
      'the Shopify id is stitched onto the customer we already had',
    );
    assert.equal(stitched.email, 'ananya.iyer@cadence-webhook-test.invalid', 'contact details refresh');
    assert.equal(stitched.city, 'Chennai');

    const all = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sql`${customers.phoneE164} = '+919900000201'
            or ${customers.email}::text like ${TEST_EMAIL_DOMAIN}`,
      );
    assert.equal(all.length, 1, 'exactly one customer exists for this person');
  });

  it('falls back to email when the inbound record has no phone', async () => {
    await cleanup();

    const [existing] = await db
      .insert(customers)
      .values({
        email: 'meera.nair@cadence-webhook-test.invalid',
        firstName: 'Meera',
        phoneE164: null,
      })
      .returning({ id: customers.id });

    const result = await processWebhook(
      'customers/update',
      fixturePayload('customers-email-only.json'),
    );

    assert.equal(result.customerId, existing.id, 'matched on email');
    const rows = await db
      .select()
      .from(customers)
      .where(eq(customers.email, 'meera.nair@cadence-webhook-test.invalid'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].shopifyCustomerId, 9900000000203);
    assert.equal(rows[0].phoneE164, null, 'a payload with no phone must not invent one');
  });

  it('prefers phone over email when the two point at different customers', async () => {
    await cleanup();

    // Two existing rows. One holds the phone the webhook carries; the other
    // holds the email. §F1.5 says phone wins.
    const [byPhone] = await db
      .insert(customers)
      .values({ phoneE164: '+919900000201', firstName: 'PhoneMatch' })
      .returning({ id: customers.id });
    const [byEmail] = await db
      .insert(customers)
      .values({ email: 'ananya.iyer@cadence-webhook-test.invalid', firstName: 'EmailMatch' })
      .returning({ id: customers.id });

    const resolved = await processWebhook(
      'customers/update',
      buildCustomerPayloadFromOrderFixture(),
    );

    assert.equal(resolved.customerId, byPhone.id, 'phone is the join key, email is the fallback');
    assert.notEqual(resolved.customerId, byEmail.id);
  });

  it('normalises a national-format phone before writing it', async () => {
    await cleanup();

    // The fixture sends "099000 00202"; the column has a CHECK that only
    // accepts E.164, so an un-normalised write would be rejected outright.
    const created = await processWebhook('customers/create', fixturePayload('customers-create.json'));
    assert.ok(created.customerId);

    const row = await customerByPhone('+919900000202');
    assert.ok(row, 'stored in E.164, not as sent');
    assert.equal(row.city, 'Mumbai');
    assert.equal(row.acceptsMarketing, true);

    const optedIn = await db
      .select()
      .from(consents)
      .where(eq(consents.customerId, row.id));
    assert.equal(optedIn.length, 3);
    assert.deepEqual(
      optedIn.map((c) => c.status),
      ['opted_in', 'opted_in', 'opted_in'],
    );

    // ...and the follow-up update converges on the same row with the consent
    // withdrawn, rather than creating a second customer.
    const updated = await processWebhook('customers/update', fixturePayload('customers-update.json'));
    assert.equal(updated.customerId, created.customerId);

    const optedOut = await db
      .select()
      .from(consents)
      .where(eq(consents.customerId, row.id));
    assert.equal(optedOut.length, 3, 'consent rows are upserted on (customer_id, channel), not duplicated');
    assert.deepEqual(
      optedOut.map((c) => c.status),
      ['opted_out', 'opted_out', 'opted_out'],
    );

    const [after] = await db.select().from(customers).where(eq(customers.id, row.id));
    assert.equal(after.city, 'Pune');
    assert.equal(after.acceptsMarketing, false);
  });

  // -------------------------------------------------------------------------
  // Checkouts
  // -------------------------------------------------------------------------

  it('starts the abandonment timer once and resets it on update', async () => {
    await cleanup();

    const created = fixturePayload('checkouts-create.json');
    const firstId = await processWebhook('checkouts/create', created);
    const retryId = await processWebhook('checkouts/create', created);
    assert.equal(firstId.eventId, retryId.eventId, 'a retry must not restart the timer');

    const started = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, 'checkout_started'),
          sql`${events.payload}->>'checkout_id' = ${TEST_CHECKOUT_ID}`,
        ),
      );
    assert.equal(started.length, 1);
    assert.equal((started[0].payload as Record<string, unknown>).value, '1898.00');

    // Two genuine updates: the second supersedes the first rather than piling up.
    await processWebhook('checkouts/update', fixturePayload('checkouts-update.json'));
    await processWebhook('checkouts/update', fixturePayload('checkouts-update.json'));

    const updated = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, 'checkout_updated'),
          sql`${events.payload}->>'checkout_id' = ${TEST_CHECKOUT_ID}`,
        ),
      );
    assert.equal(updated.length, 1, 'the latest state of the checkout, not one row per delivery');
    assert.equal((updated[0].payload as Record<string, unknown>).value, '3695.00');
    assert.equal((updated[0].payload as Record<string, unknown>).items, 3);

    const stillStarted = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.type, 'checkout_started'),
          sql`${events.payload}->>'checkout_id' = ${TEST_CHECKOUT_ID}`,
        ),
      );
    assert.equal(stillStarted.length, 1, 'the start event survives the updates');
  });

  // -------------------------------------------------------------------------
  // webhook_log (PRD-01 §6.3.4)
  // -------------------------------------------------------------------------

  it('records a rejected delivery with hmac_valid false and the reason', async () => {
    const logId = await logWebhook({
      topic: 'test/orders-create-bad-hmac',
      shopifyId: String(TEST_SHOPIFY_ORDER_ID),
      payload: fixturePayload('orders-create.json'),
      hmacValid: false,
      error: 'hmac verification failed',
    });

    const [row] = await db.select().from(webhookLog).where(eq(webhookLog.id, logId));
    assert.equal(row.hmacValid, false);
    assert.equal(row.error, 'hmac verification failed');
    assert.equal(row.shopifyId, String(TEST_SHOPIFY_ORDER_ID));
    assert.ok(row.receivedAt instanceof Date);
    assert.equal(row.processedAt, null, 'logged BEFORE processing, so processed_at is still null');
  });

  it('stores an unparseable body in webhook_log instead of dropping it', async () => {
    const raw = readFileSync(
      fileURLToPath(new URL('./fixtures/shopify/malformed-truncated.txt', import.meta.url)),
    );
    const parsed = parsePayload(raw);

    const logId = await logWebhook({
      topic: 'test/orders-create-malformed',
      shopifyId: null,
      payload: webhookLogPayload(raw, parsed),
      hmacValid: true,
      error: parsed.ok ? null : parsed.error,
    });

    const [row] = await db.select().from(webhookLog).where(eq(webhookLog.id, logId));
    const stored = row.payload as Record<string, unknown>;
    assert.equal(stored._unparsed, true);
    assert.match(String(stored._raw), /truncated@cadence-webhook-test\.invalid/);
    assert.match(String(row.error), /not valid JSON/);
  });

  it('marks a log row processed, and records a processing failure without crashing', async () => {
    const logId = await logWebhook({
      topic: 'test/orders-create-no-id',
      shopifyId: null,
      payload: { line_items: [], total_price: '10.00' },
      hmacValid: true,
    });

    // An order with no `id` has no unique key, so upserting it idempotently is
    // impossible. It must fail loudly into webhook_log.error rather than
    // silently inserting a row every retry would duplicate.
    await assert.rejects(
      () => processWebhook('orders/create', { line_items: [], total_price: '10.00' }),
      /cannot upsert idempotently/,
    );
    await markWebhookProcessed(logId, 'order payload has no usable `id`');

    const [row] = await db.select().from(webhookLog).where(eq(webhookLog.id, logId));
    assert.ok(row.processedAt instanceof Date);
    assert.match(String(row.error), /no usable/);

    // And the failure left nothing behind.
    const stray = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    assert.equal(stray[0].n, 0);
  });

  it('leaves a payload with no identity at all alone rather than inventing a customer', async () => {
    await cleanup();
    const before = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers);
    const result = await processWebhook('customers/update', { note: 'nothing identifying here' });
    assert.equal(result.customerId, null);
    const afterCount = await db.select({ n: sql<number>`count(*)::int` }).from(customers);
    assert.equal(afterCount[0].n, before[0].n, 'no anonymous customer row created');
  });
});

/**
 * The order fixture's `customer` node, promoted to a customers/* payload. Used
 * by the phone-beats-email test so it exercises the same recorded data rather
 * than a hand-built object.
 */
function buildCustomerPayloadFromOrderFixture(): Record<string, unknown> {
  const order = fixturePayload('orders-create.json');
  return order.customer as Record<string, unknown>;
}
