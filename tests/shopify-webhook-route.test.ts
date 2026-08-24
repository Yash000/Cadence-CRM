// End-to-end tests for POST /api/webhooks/shopify against a real Next server.
//
//   npm test
//
// WHY A REAL SERVER
// -----------------
// Two things cannot be proved by importing the route handler directly:
//
//   1. The raw body. Only a real HTTP request produces the exact bytes over
//      the wire that the HMAC must be computed against. Constructing a
//      `Request` in-process from a string I also signed would be the very
//      self-serialisation trap this task warns about.
//   2. `after()`. Next's `after()` throws "`after` was called outside a
//      request scope" when called from a plain Node process, so the §F1.3
//      "return 200 fast, then do the work" path only exists inside a running
//      server.
//
// So this file boots `next dev` on a spare port, signs fixture bytes read
// straight off disk with the app's real SHOPIFY_API_SECRET, POSTs them, and
// then watches Postgres for the row to appear.
//
// Skipped (not failed) when DATABASE_URL or SHOPIFY_API_SECRET is missing, or
// when CADENCE_SKIP_SERVER_TESTS is set — the dev server needs a free port and
// Postgres needs Cloudflare WARP connected.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after as afterAll, before, describe, it } from 'node:test';

// MUST come before ../db/index, which reads DATABASE_URL at import time.
import { HAS_DATABASE_URL, HAS_SHOPIFY_SECRET } from './env';

import { eq, inArray, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { signShopifyBody } from '../lib/shopify-webhook';

const { customers, events, orders, webhookLog } = schema;

const PORT = Number(process.env.CADENCE_TEST_PORT ?? 3987);
const BASE = `http://127.0.0.1:${PORT}`;
const ENDPOINT = `${BASE}/api/webhooks/shopify`;

const skipReason = process.env.CADENCE_SKIP_SERVER_TESTS
  ? 'CADENCE_SKIP_SERVER_TESTS is set'
  : !HAS_DATABASE_URL
    ? 'DATABASE_URL not set'
    : !HAS_SHOPIFY_SECRET
      ? 'SHOPIFY_API_SECRET not set'
      : false;

const TEST_SHOPIFY_ORDER_ID = 9900000000101;
const TEST_SHOPIFY_CUSTOMER_IDS = [9900000000201, 9900000000202, 9900000000203];
const TEST_CHECKOUT_ID = '9900000000901';

function fixtureBytes(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/shopify/${name}`, import.meta.url)));
}

/** POST raw bytes exactly as Shopify would, with whatever signature we choose. */
async function deliver(
  rawBody: Buffer,
  topic: string,
  signature: string | null,
): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-shopify-topic': topic,
    'x-shopify-shop-domain': 'rasaya-dev.myshopify.com',
    'x-shopify-api-version': '2025-07',
    'x-shopify-webhook-id': `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  if (signature !== null) headers['x-shopify-hmac-sha256'] = signature;

  const started = Date.now();
  // A Blob over the exact bytes. `fetch`'s BodyInit type does not accept a
  // Node Buffer (undici's and lib.dom's BodyInit disagree about ArrayBufferView),
  // and a Blob is byte-exact in a way a string re-encode would only be by
  // accident — the point of this whole file is that these bytes are untouched.
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: new Blob([new Uint8Array(rawBody)]),
  });
  const ms = Date.now() - started;
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { _raw: text };
  }
  // Remember every log row this suite caused so cleanup() can remove exactly
  // those. webhook_log is what §F1.7's sync health page reads; leaving test
  // deliveries in it would be leaving litter in a product surface.
  if (typeof body.logId === 'string') createdLogIds.add(body.logId);
  return { status: res.status, body, ms };
}

const createdLogIds = new Set<string>();

async function cleanup(): Promise<void> {
  await db.delete(orders).where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
  await db.delete(events).where(sql`${events.payload}->>'checkout_id' = ${TEST_CHECKOUT_ID}`);
  await db
    .delete(customers)
    .where(
      or(
        inArray(customers.shopifyCustomerId, TEST_SHOPIFY_CUSTOMER_IDS),
        sql`${customers.email}::text like '%@cadence-webhook-test.invalid'`,
        like(customers.phoneE164, '+91990000%'),
      ),
    );
  await db
    .delete(webhookLog)
    .where(
      or(
        inArray(webhookLog.shopifyId, [
          String(TEST_SHOPIFY_ORDER_ID),
          String(TEST_CHECKOUT_ID),
          ...TEST_SHOPIFY_CUSTOMER_IDS.map(String),
        ]),
        like(webhookLog.topic, 'test/%'),
        createdLogIds.size > 0 ? inArray(webhookLog.id, [...createdLogIds]) : sql`false`,
      ),
    );
  createdLogIds.clear();
}

/** Poll until `check` returns something truthy, or the deadline passes. */
async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ''}`);
}

let server: ChildProcess | null = null;

function stopServer(): void {
  if (!server?.pid) return;
  // The npm/next process tree does not die from a plain SIGTERM on Windows.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    server.kill('SIGTERM');
  }
  server = null;
}

describe('POST /api/webhooks/shopify', { skip: skipReason }, () => {
  const secret = process.env.SHOPIFY_API_SECRET as string;

  before(async () => {
    await cleanup();

    server = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['next', 'dev', '--turbopack', '--port', String(PORT), '--hostname', '127.0.0.1'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        stdio: 'ignore',
        shell: process.platform === 'win32',
      },
    );

    // Ready when the endpoint answers at all. GET returns 405 by design, which
    // is a fine readiness signal and also asserts the route exists.
    await waitFor(
      async () => {
        const res = await fetch(ENDPOINT, { method: 'GET' });
        return res.status === 405;
      },
      120_000,
      'next dev to start and compile the route',
    );
  });

  afterAll(async () => {
    stopServer();
    await cleanup();
  });

  it('answers GET with 405 rather than pretending to accept it', async () => {
    const res = await fetch(ENDPOINT, { method: 'GET' });
    assert.equal(res.status, 405);
  });

  it('rejects a delivery with no signature at all, and still logs it', async () => {
    const raw = fixtureBytes('orders-create.json');
    const { status } = await deliver(raw, 'orders/create', null);
    assert.equal(status, 401);

    const logged = await waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(webhookLog)
          .where(eq(webhookLog.shopifyId, String(TEST_SHOPIFY_ORDER_ID)))
          .orderBy(sql`${webhookLog.receivedAt} desc`)
          .limit(1);
        return row ?? null;
      },
      10_000,
      'the rejected delivery to appear in webhook_log',
    );
    assert.equal(logged.hmacValid, false);
    assert.match(String(logged.error), /hmac/i);
    assert.equal(
      (logged.payload as Record<string, unknown>).id,
      TEST_SHOPIFY_ORDER_ID,
      'the rejected body is kept in full — that is the whole point of logging it',
    );

    assert.equal(await countOrders(), 0, 'a rejected delivery must not be processed');
  });

  it('rejects a tampered body carrying an otherwise-valid signature', async () => {
    const raw = fixtureBytes('orders-create.json');
    const signature = signShopifyBody(raw, secret);
    const tampered = Buffer.from(
      raw.toString('utf8').replace('"total_price": "1708.00"', '"total_price": "9999.00"'),
      'utf8',
    );

    const { status } = await deliver(tampered, 'orders/create', signature);
    assert.equal(status, 401);
    assert.equal(await countOrders(), 0);
  });

  it('rejects a real signature replayed over a different payload', async () => {
    const orderRaw = fixtureBytes('orders-create.json');
    const customerRaw = fixtureBytes('customers-create.json');
    // Genuinely valid — for the customers body.
    const signature = signShopifyBody(customerRaw, secret);

    const { status } = await deliver(orderRaw, 'orders/create', signature);
    assert.equal(status, 401);
    assert.equal(await countOrders(), 0);
  });

  it('accepts a valid delivery, answers within 5s, and lands the order (§F1.3)', async () => {
    const raw = fixtureBytes('orders-create.json');
    const { status, body, ms } = await deliver(raw, 'orders/create', signShopifyBody(raw, secret));

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.logId, 'the response names the webhook_log row');
    assert.ok(ms < 5000, `responded in ${ms}ms — Shopify retries anything over 5s`);

    // The order arrives after the response, in `after()`. PRD-02's success
    // criterion is that it is visible in the CRM within 5 seconds.
    const order = await waitFor(
      async () => {
        const [row] = await db
          .select()
          .from(orders)
          .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
        return row ?? null;
      },
      5_000,
      'the order to appear in Postgres',
    );
    assert.equal(order.total, '1708.00');
    assert.ok(order.customerId, 'linked to a customer');

    const [logRow] = await db
      .select()
      .from(webhookLog)
      .where(eq(webhookLog.id, String(body.logId)));
    assert.equal(logRow.hmacValid, true);
    await waitFor(
      async () => {
        const [row] = await db.select().from(webhookLog).where(eq(webhookLog.id, String(body.logId)));
        return row.processedAt ? row : null;
      },
      10_000,
      'webhook_log.processed_at to be set once processing finished',
    );
  });

  it('absorbs Shopify retrying the identical delivery (§F1.4)', async () => {
    const raw = fixtureBytes('orders-create.json');
    const signature = signShopifyBody(raw, secret);

    // Three more identical deliveries, exactly as a retry storm looks.
    for (let i = 0; i < 3; i += 1) {
      const { status } = await deliver(raw, 'orders/create', signature);
      assert.equal(status, 200);
    }

    // Give the background work time to land, then assert it converged.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(await countOrders(), 1, 'four deliveries, one order');

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
    const lineCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    assert.equal(lineCount[0].n, 3, 'three line items, not twelve');

    const customerCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(eq(customers.shopifyCustomerId, 9900000000201));
    assert.equal(customerCount[0].n, 1, 'one customer');
  });

  it('logs a malformed body and keeps serving (does not crash the handler)', async () => {
    const raw = fixtureBytes('malformed-truncated.txt');
    const { status, body } = await deliver(raw, 'orders/create', signShopifyBody(raw, secret));

    // 200, not 4xx: the body is genuinely signed by Shopify and will never
    // become valid, so retrying it 19 times would only produce noise. The row
    // in webhook_log carries the reason.
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /not valid JSON/);

    const [logRow] = await db
      .select()
      .from(webhookLog)
      .where(eq(webhookLog.id, String(body.logId)));
    assert.equal(logRow.hmacValid, true);
    assert.equal((logRow.payload as Record<string, unknown>)._unparsed, true);
    assert.match(String(logRow.error), /not valid JSON/);

    // And the server is still alive and correct afterwards.
    const good = fixtureBytes('customers-create.json');
    const next = await deliver(good, 'customers/create', signShopifyBody(good, secret));
    assert.equal(next.status, 200);
    assert.equal(next.body.ok, true);
  });

  it('accepts an unsubscribed topic without processing it', async () => {
    const raw = fixtureBytes('orders-create.json');
    const { status, body } = await deliver(raw, 'orders/paid', signShopifyBody(raw, secret));
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /unsupported topic: orders\/paid/);
  });
});

async function countOrders(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.shopifyOrderId, TEST_SHOPIFY_ORDER_ID));
  return rows[0].n;
}
