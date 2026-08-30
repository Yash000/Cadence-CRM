// Route-level tests for POST/GET /api/events (PRD-01 §7, task-9-brief.md).
//
// Unlike tests/shopify-webhook-route.test.ts, this does NOT need a real HTTP
// server: there is no raw-byte HMAC to preserve (nothing here is signed) and
// the route does its DB write inline rather than inside `after()` (the
// insert is a single fast INSERT, so there is no "return 200 fast, do the
// real work later" split to prove). The handler is imported and invoked
// directly with a constructed Request, which is enough to exercise real
// validation and a real database round trip.
//
// Skipped with a message rather than failing if DATABASE_URL is unavailable
// — same as every other DB-touching suite in this repo.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after as afterAll, before, describe, it } from 'node:test';

// MUST come before ../db/index (via ../app/api/events/route), which reads
// DATABASE_URL at import time.
import { HAS_DATABASE_URL } from './env';

import { like } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { GET, POST } from '../app/api/events/route';

const { events } = schema;

const RUN_ID = randomUUID().slice(0, 8);
const SESSION_PREFIX = `cadence-events-route-test-${RUN_ID}`;

async function cleanup(): Promise<void> {
  await db.delete(events).where(like(events.sessionId, `${SESSION_PREFIX}%`));
}

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe(
  'POST/GET /api/events',
  { skip: HAS_DATABASE_URL ? false : 'DATABASE_URL not set' },
  () => {
    before(cleanup);
    afterAll(cleanup);

    it('accepts a valid payload, returns 201, and the row lands in `events`', async () => {
      const sessionId = `${SESSION_PREFIX}-valid`;
      const res = await POST(
        postRequest({
          type: 'page_view',
          session_id: sessionId,
          payload: { template: 'index' },
        }),
      );
      assert.equal(res.status, 201);
      const body = (await res.json()) as { ok: boolean; id: string };
      assert.equal(body.ok, true);
      assert.ok(body.id);

      const [row] = await db.select().from(events).where(like(events.sessionId, sessionId)).limit(1);
      assert.ok(row, 'row should exist in events');
      assert.equal(row.type, 'page_view');
    });

    it('stamps source=storefront_pixel when the simulator header is absent', async () => {
      const sessionId = `${SESSION_PREFIX}-pixel-source`;
      await POST(postRequest({ type: 'page_view', session_id: sessionId }));
      const [row] = await db.select().from(events).where(like(events.sessionId, sessionId)).limit(1);
      assert.equal((row.payload as Record<string, unknown>).source, 'storefront_pixel');
    });

    it('stamps source=simulator when the caller sends the simulator header', async () => {
      const sessionId = `${SESSION_PREFIX}-sim-source`;
      await POST(
        postRequest(
          { type: 'page_view', session_id: sessionId },
          { 'x-cadence-source': 'simulator' },
        ),
      );
      const [row] = await db.select().from(events).where(like(events.sessionId, sessionId)).limit(1);
      assert.equal((row.payload as Record<string, unknown>).source, 'simulator');
    });

    it('rejects a body that is not valid JSON with 400', async () => {
      const res = await POST(postRequest('{not json'));
      assert.equal(res.status, 400);
      const body = (await res.json()) as { ok: boolean; error: string };
      assert.equal(body.ok, false);
      assert.match(body.error, /JSON/i);
    });

    it('rejects an unknown event type with 400 and inserts nothing', async () => {
      const sessionId = `${SESSION_PREFIX}-bad-type`;
      const res = await POST(postRequest({ type: 'purchase', session_id: sessionId }));
      assert.equal(res.status, 400);

      const rows = await db.select().from(events).where(like(events.sessionId, sessionId));
      assert.equal(rows.length, 0);
    });

    it('rejects a malformed customer_id with 400', async () => {
      const res = await POST(postRequest({ type: 'page_view', customer_id: 'not-a-number' }));
      assert.equal(res.status, 400);
    });

    it('GET lists recent events, including one just inserted', async () => {
      const sessionId = `${SESSION_PREFIX}-get-list`;
      await POST(postRequest({ type: 'add_to_cart', session_id: sessionId }));

      const res = await GET(new Request('http://localhost/api/events?limit=50'));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { ok: boolean; events: Array<{ sessionId: string | null }> };
      assert.equal(body.ok, true);
      assert.ok(body.events.some((e) => e.sessionId === sessionId));
    });
  },
);
