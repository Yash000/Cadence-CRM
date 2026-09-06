// Pure validation tests for the storefront event tracking endpoint
// (PRD-01 §7, task-9-brief.md). lib/events.ts has no server-only import and
// no DATABASE_URL dependency, so this runs without Postgres or WARP.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTrackedEventType, parseEventInput, TRACKED_EVENT_TYPES } from '../lib/events';

describe('isTrackedEventType', () => {
  it('accepts exactly the four PRD-01 §7 types', () => {
    for (const t of TRACKED_EVENT_TYPES) assert.equal(isTrackedEventType(t), true);
    assert.equal(TRACKED_EVENT_TYPES.length, 4);
  });

  it('rejects anything else, including near-misses and non-strings', () => {
    assert.equal(isTrackedEventType('checkout_abandoned'), false); // real events.type value, but not a §7 tracking type
    assert.equal(isTrackedEventType('Page_View'), false);
    assert.equal(isTrackedEventType(''), false);
    assert.equal(isTrackedEventType(null), false);
    assert.equal(isTrackedEventType(123), false);
  });
});

describe('parseEventInput — valid payloads accepted', () => {
  it('accepts the minimal valid body (type only)', () => {
    const r = parseEventInput({ type: 'page_view' }, 'storefront_pixel');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.type, 'page_view');
    assert.equal(r.value.shopifyCustomerId, null);
    assert.equal(r.value.sessionId, null);
    assert.deepEqual(r.value.payload, {});
    assert.ok(r.value.occurredAt instanceof Date);
    assert.equal(r.value.source, 'storefront_pixel');
  });

  it('accepts a fully populated body matching what the theme snippet sends', () => {
    const r = parseEventInput(
      {
        type: 'product_view',
        customer_id: 8675309,
        session_id: 'sess_abc123',
        payload: { id: 'gid://shopify/Product/1', title: 'Jaipur Dhurrie Rug', price: '16500.00' },
        occurred_at: '2026-08-24T09:00:00Z',
      },
      'storefront_pixel',
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.shopifyCustomerId, 8675309);
    assert.equal(r.value.sessionId, 'sess_abc123');
    assert.equal(r.value.payload.title, 'Jaipur Dhurrie Rug');
    assert.equal(r.value.occurredAt.toISOString(), '2026-08-24T09:00:00.000Z');
  });

  it('accepts a numeric-string customer_id (JSON.parse of some clients hands back a string)', () => {
    const r = parseEventInput({ type: 'add_to_cart', customer_id: '42' }, 'simulator');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.shopifyCustomerId, 42);
  });

  it('tags the source from the caller, not the body — a client cannot claim to be the storefront pixel', () => {
    const r = parseEventInput({ type: 'page_view', source: 'storefront_pixel' }, 'simulator');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.source, 'simulator'); // "source" in the body is ignored
  });
});

describe('parseEventInput — malformed payloads rejected', () => {
  it('rejects a non-object body', () => {
    assert.equal(parseEventInput(null, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput('page_view', 'storefront_pixel').ok, false);
    assert.equal(parseEventInput([{ type: 'page_view' }], 'storefront_pixel').ok, false);
    assert.equal(parseEventInput(42, 'storefront_pixel').ok, false);
  });

  it('rejects a missing or unknown type', () => {
    assert.equal(parseEventInput({}, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'purchase' }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 123 }, 'storefront_pixel').ok, false);
  });

  it('rejects a non-positive-integer customer_id', () => {
    assert.equal(parseEventInput({ type: 'page_view', customer_id: -1 }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', customer_id: 0 }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', customer_id: 1.5 }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', customer_id: 'not-a-number' }, 'storefront_pixel').ok, false);
  });

  it('rejects a non-string session_id and an oversized one', () => {
    assert.equal(parseEventInput({ type: 'page_view', session_id: 123 }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', session_id: '' }, 'storefront_pixel').ok, false);
    assert.equal(
      parseEventInput({ type: 'page_view', session_id: 'x'.repeat(129) }, 'storefront_pixel').ok,
      false,
    );
  });

  it('rejects a non-object payload and an oversized one', () => {
    assert.equal(parseEventInput({ type: 'page_view', payload: 'nope' }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', payload: [1, 2, 3] }, 'storefront_pixel').ok, false);
    assert.equal(
      parseEventInput({ type: 'page_view', payload: { blob: 'x'.repeat(9000) } }, 'storefront_pixel').ok,
      false,
    );
  });

  it('rejects an unparseable occurred_at', () => {
    assert.equal(parseEventInput({ type: 'page_view', occurred_at: 'not-a-date' }, 'storefront_pixel').ok, false);
    assert.equal(parseEventInput({ type: 'page_view', occurred_at: 123 }, 'storefront_pixel').ok, false);
  });
});
