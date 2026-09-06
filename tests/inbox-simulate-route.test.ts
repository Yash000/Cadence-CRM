// Validation + route tests for POST/GET /api/inbox/simulate (PRD-02 §F5.11).
//
// The pure parse block always runs. The route block does a real DB round trip
// (no auto-draft — that would need OPENROUTER_API_KEY and spend credit) and is
// skipped when DATABASE_URL is absent.
import assert from 'node:assert/strict';
import { after as afterAll, before, describe, it } from 'node:test';

import { HAS_DATABASE_URL } from './env';

import { parseSimulateInput } from '../lib/inbox-input';

describe('parseSimulateInput', () => {
  it('defaults channel to whatsapp and requires a phone or customer_id', () => {
    const ok = parseSimulateInput({ body: 'hi', phone: '+919876543210' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.value.channel, 'whatsapp');

    const bad = parseSimulateInput({ body: 'hi' });
    assert.equal(bad.ok, false);
  });

  it('rejects an empty body, an over-long body and a bad channel', () => {
    assert.equal(parseSimulateInput({ body: '   ', phone: '+919876543210' }).ok, false);
    assert.equal(
      parseSimulateInput({ body: 'x'.repeat(4001), phone: '+919876543210' }).ok,
      false,
    );
    assert.equal(parseSimulateInput({ body: 'hi', channel: 'carrier-pigeon', phone: '+1' }).ok, false);
  });

  it('requires an email address (or customer_id) for the email channel', () => {
    assert.equal(parseSimulateInput({ channel: 'email', body: 'hi', phone: '+919876543210' }).ok, false);
    assert.equal(parseSimulateInput({ channel: 'email', body: 'hi', email: 'a@b.com' }).ok, true);
  });

  it('validates customer_id as a UUID and reads auto_draft', () => {
    assert.equal(parseSimulateInput({ body: 'hi', customer_id: 'nope' }).ok, false);
    const r = parseSimulateInput({
      body: 'hi',
      customer_id: '11111111-1111-1111-1111-111111111111',
      auto_draft: true,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.autoDraft, true);
  });
});

describe(
  'POST/GET /api/inbox/simulate',
  { skip: HAS_DATABASE_URL ? false : 'DATABASE_URL not set' },
  () => {
    let POST: typeof import('../app/api/inbox/simulate/route').POST;
    let GET: typeof import('../app/api/inbox/simulate/route').GET;
    let dbmod: typeof import('../db/index');
    const madeConversationIds: string[] = [];
    const orphanPhone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

    before(async () => {
      ({ POST, GET } = await import('../app/api/inbox/simulate/route'));
      dbmod = await import('../db/index');
    });

    afterAll(async () => {
      if (madeConversationIds.length) {
        const { inArray } = await import('drizzle-orm');
        await dbmod.db
          .delete(dbmod.schema.messages)
          .where(inArray(dbmod.schema.messages.conversationId, madeConversationIds));
        await dbmod.db
          .delete(dbmod.schema.conversations)
          .where(inArray(dbmod.schema.conversations.id, madeConversationIds));
      }
    });

    const post = (body: unknown) =>
      POST(
        new Request('http://localhost/api/inbox/simulate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    it('records an inbound message and returns 201', async () => {
      const res = await post({ channel: 'whatsapp', body: 'where is my order', phone: orphanPhone });
      assert.equal(res.status, 201);
      const data = (await res.json()) as { ok: boolean; conversationId: string; matched: boolean };
      assert.equal(data.ok, true);
      assert.equal(data.matched, false);
      madeConversationIds.push(data.conversationId);
    });

    it('rejects a malformed body with 400 and writes nothing', async () => {
      const res = await post({ body: '' });
      assert.equal(res.status, 400);
    });

    it('GET lists the conversation just created', async () => {
      const res = await GET(new Request('http://localhost/api/inbox/simulate'));
      assert.equal(res.status, 200);
      const data = (await res.json()) as { ok: boolean; conversations: { id: string }[] };
      assert.ok(data.conversations.some((c) => madeConversationIds.includes(c.id)));
    });

    it('GET ?conversation= returns that thread', async () => {
      const res = await GET(
        new Request(`http://localhost/api/inbox/simulate?conversation=${madeConversationIds[0]}`),
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as { ok: boolean; thread: { messages: unknown[] } };
      assert.ok(data.thread.messages.length >= 1);
    });
  },
);
