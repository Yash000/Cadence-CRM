// Unit tests for the Shopify webhook endpoint's pure logic (PRD-02 §F1).
//
//   npm test
//
// Nothing here touches the database or the network — see
// tests/shopify-webhook-db.test.ts for the idempotency and identity-resolution
// tests, which have to run against real UNIQUE constraints to prove anything.
//
// A NOTE ON WHAT MAKES AN HMAC TEST WORTH ANYTHING
// ------------------------------------------------
// The failure mode these tests are written against is a suite that serialises
// the payload itself on both sides — sign `JSON.stringify(payload)`, verify
// `JSON.stringify(payload)` — which passes no matter what the handler does
// with the raw body, and would happily green-light an implementation that
// verifies against re-serialised JSON and rejects every real delivery.
//
// So: every body here is the raw bytes of a fixture file on disk, read with
// readFileSync and never round-tripped. `signature over re-serialised JSON is
// rejected` asserts the difference explicitly, and `matches a digest computed
// by OpenSSL` pins our digest to a constant produced by a different crypto
// implementation entirely (`openssl dgst -sha256 -hmac … | openssl base64`),
// so the whole suite cannot agree with itself and be wrong.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  SHOPIFY_WEBHOOK_TOPICS,
  buildCheckoutInput,
  buildCustomerInput,
  buildOrderInput,
  extractShopifyId,
  isSupportedTopic,
  mapFinancialStatus,
  normalizeE164,
  parsePayload,
  signShopifyBody,
  toMoney,
  verifyShopifyHmac,
  webhookLogPayload,
} from '../lib/shopify-webhook';

const TEST_SECRET = 'shpss_cadence_task6_test_secret';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/shopify/${name}`, import.meta.url)));
}

function payloadOf(name: string) {
  const parsed = parsePayload(fixture(name));
  assert.equal(parsed.ok, true, `${name} should parse`);
  return (parsed as { ok: true; value: Record<string, unknown> }).value;
}

const ordersCreateRaw = fixture('orders-create.json');
const customersCreateRaw = fixture('customers-create.json');

// ---------------------------------------------------------------------------

describe('HMAC verification (§F1.2)', () => {
  it('matches a digest computed by OpenSSL, not just by ourselves', () => {
    // Produced independently of node:crypto with:
    //   openssl dgst -sha256 -hmac "shpss_cadence_task6_test_secret" -binary \
    //     tests/fixtures/shopify/orders-create.json | openssl base64 -A
    // .gitattributes marks tests/fixtures/** as -text so these bytes survive
    // checkout on Windows; if that were lost, this assertion is what fails.
    // Recomputed with the OpenSSL command above (not with node:crypto, which
    // would defeat the point) after the fixture was rebranded to HomeStyle —
    // the shop domain, vendor, discount code, line-item title, and finally the
    // product_id/variant_id (once real Shopify ids were captured from the live
    // store) all changed, so the digest over the raw bytes changed with them.
    const goldenOrders = 'OIjqOc9nlLpzgmT50rrPLtsF2rxf4/LoucZMzWvRueE=';
    const goldenCustomers = 'z2dzWVAIm/dmNbiwslbJFbQoRUSt25WNczsIF5LeVhM=';

    assert.equal(signShopifyBody(ordersCreateRaw, TEST_SECRET), goldenOrders);
    assert.equal(signShopifyBody(customersCreateRaw, TEST_SECRET), goldenCustomers);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, goldenOrders, TEST_SECRET), true);
    assert.equal(verifyShopifyHmac(customersCreateRaw, goldenCustomers, TEST_SECRET), true);
  });

  it('accepts a valid signature over the raw body', () => {
    const sig = signShopifyBody(ordersCreateRaw, TEST_SECRET);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sig, TEST_SECRET), true);
  });

  it('rejects a tampered body', () => {
    const sig = signShopifyBody(ordersCreateRaw, TEST_SECRET);
    // One byte: the order total 1708.00 -> 1708.09. Nothing else changes.
    const tampered = Buffer.from(
      ordersCreateRaw.toString('utf8').replace('"total_price": "1708.00"', '"total_price": "1708.09"'),
      'utf8',
    );
    assert.notEqual(tampered.length === ordersCreateRaw.length, false, 'edit must be same length');
    assert.notDeepEqual(tampered, ordersCreateRaw, 'the tamper must actually change the bytes');
    assert.equal(verifyShopifyHmac(tampered, sig, TEST_SECRET), false);
  });

  it('rejects a genuinely valid signature presented over different bytes', () => {
    // A real signature, correctly computed with the real secret — over the
    // customers fixture. Replaying it against the orders body must fail: this
    // is the "captured a signature, swapped the payload" attack.
    const sigForCustomers = signShopifyBody(customersCreateRaw, TEST_SECRET);
    assert.equal(verifyShopifyHmac(customersCreateRaw, sigForCustomers, TEST_SECRET), true);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sigForCustomers, TEST_SECRET), false);
  });

  it('rejects a signature over re-serialised JSON', () => {
    // JSON.parse -> JSON.stringify does not round-trip byte-identically. This
    // is both the reason the handler must digest the raw body and the reason
    // this whole suite refuses to re-serialise anything.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(ordersCreateRaw.toString('utf8'))), 'utf8');
    assert.notEqual(
      reserialised.toString('utf8'),
      ordersCreateRaw.toString('utf8'),
      'fixture must not already be in canonical JSON.stringify form, or this test proves nothing',
    );
    const sigOverReserialised = signShopifyBody(reserialised, TEST_SECRET);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sigOverReserialised, TEST_SECRET), false);
  });

  it('rejects the wrong secret', () => {
    const sig = signShopifyBody(ordersCreateRaw, 'shpss_some_other_app_secret');
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sig, TEST_SECRET), false);
  });

  it('rejects a missing, empty or malformed header without throwing', () => {
    for (const header of [null, undefined, '', 'not-base64-at-all', 'AAAA', '!!!!']) {
      assert.equal(verifyShopifyHmac(ordersCreateRaw, header, TEST_SECRET), false, String(header));
    }
  });

  it('rejects everything when the secret is unset', () => {
    const sig = signShopifyBody(ordersCreateRaw, TEST_SECRET);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sig, undefined), false);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sig, ''), false);
  });

  it('rejects a truncated signature rather than throwing in timingSafeEqual', () => {
    const sig = signShopifyBody(ordersCreateRaw, TEST_SECRET);
    assert.equal(verifyShopifyHmac(ordersCreateRaw, sig.slice(0, 20), TEST_SECRET), false);
  });
});

// ---------------------------------------------------------------------------

describe('topics (PRD-01 §6.2)', () => {
  it('supports all seven subscribed topics and nothing else', () => {
    assert.deepEqual([...SHOPIFY_WEBHOOK_TOPICS], [
      'orders/create',
      'orders/updated',
      'orders/cancelled',
      'customers/create',
      'customers/update',
      'checkouts/create',
      'checkouts/update',
    ]);
    for (const topic of SHOPIFY_WEBHOOK_TOPICS) assert.equal(isSupportedTopic(topic), true, topic);
    for (const topic of ['app/uninstalled', 'orders/paid', 'ORDERS/CREATE', '', null, undefined]) {
      assert.equal(isSupportedTopic(topic), false, String(topic));
    }
  });
});

// ---------------------------------------------------------------------------

describe('malformed payloads are described, not thrown', () => {
  it('reports truncated JSON as a parse error', () => {
    const raw = fixture('malformed-truncated.txt');
    const parsed = parsePayload(raw);
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; error: string }).error, /not valid JSON/);
  });

  it('still produces a loggable jsonb payload for an unparseable body', () => {
    const raw = fixture('malformed-truncated.txt');
    const logged = webhookLogPayload(raw, parsePayload(raw));
    assert.equal(logged._unparsed, true);
    assert.equal(logged._raw_bytes, raw.length);
    assert.match(String(logged._raw), /truncated@cadence-webhook-test\.invalid/);
    assert.match(String(logged._parse_error), /not valid JSON/);
    // Must survive the round trip into a jsonb column.
    assert.doesNotThrow(() => JSON.stringify(logged));
  });

  it('rejects JSON that is valid but not an object', () => {
    for (const body of ['[]', '"hello"', '42', 'null', 'true']) {
      const parsed = parsePayload(Buffer.from(body, 'utf8'));
      assert.equal(parsed.ok, false, body);
      assert.match((parsed as { ok: false; error: string }).error, /expected a JSON object/);
    }
  });

  it('logs the parsed object verbatim when the body is fine', () => {
    const parsed = parsePayload(ordersCreateRaw);
    const logged = webhookLogPayload(ordersCreateRaw, parsed);
    assert.equal(logged.id, 9900000000101);
    assert.equal(logged._unparsed, undefined);
  });

  it('extracts the resource id, falling back to a checkout token', () => {
    assert.equal(extractShopifyId(payloadOf('orders-create.json')), '9900000000101');
    assert.equal(extractShopifyId(payloadOf('customers-create.json')), '9900000000202');
    assert.equal(extractShopifyId({ token: 'abc123' }), 'abc123');
    assert.equal(extractShopifyId({}), null);
    assert.equal(extractShopifyId(null), null);
  });
});

// ---------------------------------------------------------------------------

describe('E.164 normalisation (§F1.5)', () => {
  it('accepts the formats Shopify actually sends for an Indian number', () => {
    for (const input of [
      '+919900000201',
      '+91 99000 00201',
      '+91-99000-00201',
      ' +91 (99000) 00201 ',
      '00919900000201',
      '9900000201',
      '09900000201',
      '919900000201',
    ]) {
      assert.equal(normalizeE164(input), '+919900000201', `input: ${input}`);
    }
  });

  it('leaves an already-valid non-Indian number alone', () => {
    assert.equal(normalizeE164('+14155550123'), '+14155550123');
    assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958');
  });

  it('returns null rather than writing something the DB CHECK would reject', () => {
    // customers.phone_e164 CHECK is ^\+[1-9][0-9]{7,14}$.
    for (const input of [null, undefined, '', '   ', 'not a phone', '+', '+0123456789', '12345', '+9199000002011234567']) {
      assert.equal(normalizeE164(input), null, `input: ${String(input)}`);
    }
  });

  it('matches the DB CHECK for every value it does return', () => {
    const check = /^\+[1-9][0-9]{7,14}$/;
    for (const input of ['9900000201', '+91 99000 00201', '+14155550123', '00442079460958']) {
      const out = normalizeE164(input);
      assert.ok(out && check.test(out), `${input} -> ${out}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('money and status mapping', () => {
  it('keeps money as exact decimal strings', () => {
    assert.equal(toMoney('1708.00'), '1708.00');
    assert.equal(toMoney('0.00'), '0.00');
    assert.equal(toMoney(' 1299.00 '), '1299.00');
    assert.equal(toMoney(null), null);
    assert.equal(toMoney('₹1,708.00'), null);
  });

  it('maps Shopify financial states onto financial_status_t', () => {
    assert.equal(mapFinancialStatus('paid'), 'paid');
    assert.equal(mapFinancialStatus('partially_refunded'), 'partially_refunded');
    assert.equal(mapFinancialStatus('refunded'), 'refunded');
    assert.equal(mapFinancialStatus('voided'), 'voided');
    // Shopify has partially_paid; the enum does not.
    assert.equal(mapFinancialStatus('partially_paid'), 'authorized');
    assert.equal(mapFinancialStatus(null), 'pending');
    assert.equal(mapFinancialStatus('something_new_from_shopify'), 'pending');
  });
});

// ---------------------------------------------------------------------------

describe('order payload mapping', () => {
  const order = buildOrderInput(payloadOf('orders-create.json'));

  it('reads the identifying and money fields exactly', () => {
    assert.equal(order.shopifyOrderId, 9900000000101);
    assert.equal(order.orderNumber, '#1147');
    assert.equal(order.total, '1708.00');
    assert.equal(order.subtotal, '1898.00');
    assert.equal(order.discountTotal, '190.00');
    assert.deepEqual(order.discountCodes, ['HOMESTYLE10']);
    assert.equal(order.currency, 'INR');
    assert.equal(order.financialStatus, 'paid');
    assert.equal(order.cancelledAt, null);
    assert.equal(order.processedAt.toISOString(), '2026-08-24T08:42:07.000Z');
  });

  it('carries the line items with real catalogue product ids', () => {
    assert.equal(order.lines.length, 3);
    assert.deepEqual(order.lines.map((l) => l.shopifyProductId), [
      10427354906920, 10427355136296, 10427354808616,
    ]);
    assert.deepEqual(order.lines.map((l) => l.qty), [1, 1, 2]);
    assert.deepEqual(order.lines.map((l) => l.price), ['1299.00', '399.00', '599.00']);
  });

  it('resolves the buyer identity off the order', () => {
    assert.equal(order.customer.shopifyCustomerId, 9900000000201);
    assert.equal(order.customer.phoneE164, '+919900000201');
    assert.equal(order.customer.email, 'ananya.iyer@cadence-webhook-test.invalid');
    assert.equal(order.customer.city, 'Chennai');
    assert.equal(order.customer.state, 'Tamil Nadu');
    assert.deepEqual(order.customer.consents, [
      { channel: 'email', status: 'opted_in' },
      { channel: 'sms', status: 'opted_out' },
      { channel: 'whatsapp', status: 'opted_out' },
    ]);
  });

  it('reads a cancellation', () => {
    const cancelled = buildOrderInput(payloadOf('orders-cancelled.json'));
    assert.equal(cancelled.shopifyOrderId, 9900000000101, 'same order id — this is an update, not a new order');
    assert.equal(cancelled.cancelledAt?.toISOString(), '2026-08-25T04:33:44.000Z');
    assert.equal(cancelled.financialStatus, 'refunded');
    assert.deepEqual(cancelled.lines, []);
  });

  it('reads an update as the same order with different money', () => {
    const updated = buildOrderInput(payloadOf('orders-updated.json'));
    assert.equal(updated.shopifyOrderId, 9900000000101);
    assert.equal(updated.total, '1169.00');
    assert.equal(updated.financialStatus, 'partially_refunded');
    assert.equal(updated.lines.length, 1);
  });

  it('defaults a bad quantity to 1 so the CHECK (qty > 0) cannot be violated', () => {
    const weird = buildOrderInput({
      id: 1,
      total_price: '10.00',
      processed_at: '2026-08-24T00:00:00Z',
      line_items: [
        { product_id: 1, quantity: 0, price: '10.00' },
        { product_id: 2, quantity: -3, price: '10.00' },
        { product_id: 3, price: '10.00' },
        'not an object',
      ],
    });
    assert.deepEqual(weird.lines.map((l) => l.qty), [1, 1, 1]);
  });
});

// ---------------------------------------------------------------------------

describe('customer payload mapping', () => {
  it('normalises a national-format phone from a customers/create', () => {
    const created = buildCustomerInput(payloadOf('customers-create.json'));
    assert.equal(created.shopifyCustomerId, 9900000000202);
    assert.equal(created.phoneE164, '+919900000202', 'fixture sends "099000 00202"');
    assert.equal(created.email, 'rohan.desai@cadence-webhook-test.invalid');
    assert.equal(created.city, 'Mumbai');
    assert.equal(created.acceptsMarketing, true);
    assert.deepEqual(created.consents, [
      { channel: 'email', status: 'opted_in' },
      { channel: 'sms', status: 'opted_in' },
      { channel: 'whatsapp', status: 'opted_in' },
    ]);
  });

  it('reads a consent withdrawal from a customers/update', () => {
    const updated = buildCustomerInput(payloadOf('customers-update.json'));
    assert.equal(updated.shopifyCustomerId, 9900000000202, 'same customer as the create');
    assert.equal(updated.phoneE164, '+919900000202');
    assert.equal(updated.city, 'Pune');
    assert.equal(updated.acceptsMarketing, false);
    assert.deepEqual(updated.consents, [
      { channel: 'email', status: 'opted_out' },
      { channel: 'sms', status: 'opted_out' },
      { channel: 'whatsapp', status: 'opted_out' },
    ]);
  });

  it('handles a customer with no phone and no address at all', () => {
    const emailOnly = buildCustomerInput(payloadOf('customers-email-only.json'));
    assert.equal(emailOnly.phoneE164, null);
    assert.equal(emailOnly.email, 'meera.nair@cadence-webhook-test.invalid');
    assert.equal(emailOnly.city, null);
    assert.equal(emailOnly.acceptsMarketing, false);
    assert.deepEqual(
      emailOnly.consents,
      [],
      '"not_subscribed" is unknown, not opted_out — say nothing rather than claim more than Shopify does',
    );
  });

  it('says nothing identifying when the payload is empty', () => {
    const empty = buildCustomerInput(null);
    assert.equal(empty.shopifyCustomerId, null);
    assert.equal(empty.phoneE164, null);
    assert.equal(empty.email, null);
  });
});

// ---------------------------------------------------------------------------

describe('checkout payload mapping', () => {
  it('maps checkouts/create to a checkout_started event', () => {
    const created = buildCheckoutInput('checkouts/create', payloadOf('checkouts-create.json'));
    assert.ok(created);
    assert.equal(created.eventType, 'checkout_started');
    assert.equal(created.checkoutId, '9900000000901');
    assert.equal(created.sessionId, 'c1-9f2b7a41d5e64c0e8f3b2a1c7d904e55');
    assert.equal(created.value, '1898.00');
    assert.equal(created.itemCount, 2);
    assert.equal(created.occurredAt.toISOString(), '2026-08-24T08:38:31.000Z');
    assert.equal(created.customer.phoneE164, '+919900000201');
  });

  it('maps checkouts/update to a checkout_updated event on the same checkout', () => {
    const updated = buildCheckoutInput('checkouts/update', payloadOf('checkouts-update.json'));
    assert.ok(updated);
    assert.equal(updated.eventType, 'checkout_updated');
    assert.equal(updated.checkoutId, '9900000000901', 'same checkout as the create');
    assert.equal(updated.value, '3695.00');
    assert.equal(updated.itemCount, 3);
    assert.equal(updated.occurredAt.toISOString(), '2026-08-24T08:40:46.000Z', 'uses updated_at, not created_at');
  });

  it('refuses a checkout with nothing to dedupe on', () => {
    assert.equal(buildCheckoutInput('checkouts/create', { total_price: '10.00' }), null);
  });
});
