// Pure-logic + database tests for the Inbox data layer (lib/inbox-db.ts).
//
// The pure block (normaliseE164, sessionWindowOpen, editedPct, fallbackDraft)
// runs everywhere. The DB block round-trips a real inbound message and the
// approve/reject state machine, and is skipped with a message when
// DATABASE_URL is absent — same convention as every other DB suite here.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { HAS_DATABASE_URL } from './env';

import {
  editedPct,
  fallbackDraft,
  normaliseE164,
  sessionWindowOpen,
  SESSION_WINDOW_MS,
} from '../lib/inbox-db';

describe('normaliseE164', () => {
  it('passes through a valid E.164 number', () => {
    assert.equal(normaliseE164('+919876543210'), '+919876543210');
  });
  it('adds +91 to a bare 10-digit Indian mobile', () => {
    assert.equal(normaliseE164('9876543210'), '+919876543210');
  });
  it('strips spaces, dashes and parens', () => {
    assert.equal(normaliseE164('+91 98765-43210'), '+919876543210');
    assert.equal(normaliseE164('(020) 1234 5678'), null); // 8 local digits, no CC → unresolvable
  });
  it('converts a 00 international prefix to +', () => {
    assert.equal(normaliseE164('0049123456789'), '+49123456789');
  });
  it('rejects junk and empty input', () => {
    assert.equal(normaliseE164(''), null);
    assert.equal(normaliseE164(null), null);
    assert.equal(normaliseE164('not a phone'), null);
    assert.equal(normaliseE164('+0123456789'), null); // leading 0 after +
  });
});

describe('sessionWindowOpen', () => {
  const now = 1_000_000_000_000;
  it('is open just inside 24h', () => {
    assert.equal(sessionWindowOpen(new Date(now - SESSION_WINDOW_MS + 1000), now), true);
  });
  it('is closed just outside 24h', () => {
    assert.equal(sessionWindowOpen(new Date(now - SESSION_WINDOW_MS - 1000), now), false);
  });
  it('is closed with no inbound timestamp', () => {
    assert.equal(sessionWindowOpen(null, now), false);
  });
});

describe('editedPct', () => {
  it('is 0 for an untouched draft', () => {
    assert.equal(editedPct('hello there', 'hello there'), 0);
  });
  it('grows with the size of the edit', () => {
    const small = editedPct('the quick brown fox', 'the quick brown foxes');
    const big = editedPct('the quick brown fox', 'a totally different sentence entirely');
    assert.ok(small > 0 && small < big);
    assert.ok(big <= 100);
  });
});

describe('fallbackDraft', () => {
  it('greets by first name and signs off per channel', () => {
    const wa = fallbackDraft('Priya Menon', 'whatsapp');
    assert.match(wa, /Hi Priya/);
    assert.match(wa, /HomeStyle Care$/);
    assert.match(fallbackDraft(null, 'email'), /Hi there/);
  });
});

describe(
  'inbox-db · database',
  { skip: HAS_DATABASE_URL ? false : 'DATABASE_URL not set' },
  () => {
    let mod: typeof import('../lib/inbox-db');
    let dbmod: typeof import('../db/index');
    const madeConversationIds: string[] = [];
    // A phone that resolves to no seeded customer — keeps the test self-contained.
    const orphanPhone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

    before(async () => {
      mod = await import('../lib/inbox-db');
      dbmod = await import('../db/index');
    });

    after(async () => {
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

    it('lands an unknown-contact inbound message and reuses the thread on a second message', async () => {
      const first = await mod.recordInboundMessage({
        channel: 'whatsapp',
        body: 'first message from a stranger',
        phone: orphanPhone,
      });
      madeConversationIds.push(first.conversationId);
      assert.equal(first.matched, false);
      assert.equal(first.newConversation, true);

      const second = await mod.recordInboundMessage({
        channel: 'whatsapp',
        body: 'second message, same stranger',
        phone: orphanPhone,
      });
      assert.equal(second.conversationId, first.conversationId);
      assert.equal(second.newConversation, false);

      const thread = await mod.getThread(first.conversationId);
      assert.ok(thread);
      assert.equal(thread.customer, null);
      assert.equal(thread.messages.length, 2);
      assert.equal(thread.messages[0].direction, 'inbound');
    });

    it('approves a held draft: held → sent, edit percentage recorded', async () => {
      const inbound = await mod.recordInboundMessage({
        channel: 'whatsapp',
        body: 'need help with an order',
        phone: orphanPhone,
      });
      madeConversationIds.push(inbound.conversationId);

      const draft = await mod.insertOutboundDraft({
        conversationId: inbound.conversationId,
        body: 'original draft body here',
        aiGenerated: true,
      });

      const result = await mod.approveDraft({
        messageId: draft.id,
        finalBody: 'original draft body here, with a rep edit',
        externalId: null,
      });
      assert.equal(result.simulated, true);
      assert.ok((result.aiEditedPct ?? 0) > 0);

      const thread = await mod.getThread(inbound.conversationId);
      const sent = thread!.messages.find((m) => m.id === draft.id);
      assert.equal(sent?.status, 'sent');
      assert.match(sent?.body ?? '', /rep edit/);

      // A second approve of the same message must fail — it is no longer held.
      await assert.rejects(
        () => mod.approveDraft({ messageId: draft.id }),
        /awaiting approval/,
      );
    });

    it('rejects a held draft: held → failed with a reason', async () => {
      const inbound = await mod.recordInboundMessage({
        channel: 'sms',
        body: 'another one',
        phone: orphanPhone,
      });
      madeConversationIds.push(inbound.conversationId);
      const draft = await mod.insertOutboundDraft({
        conversationId: inbound.conversationId,
        body: 'draft to reject',
        aiGenerated: true,
      });
      await mod.rejectDraft(draft.id, 'wrong tone');
      const thread = await mod.getThread(inbound.conversationId);
      const m = thread!.messages.find((x) => x.id === draft.id);
      assert.equal(m?.status, 'failed');
      assert.match(m?.heldReason ?? '', /rejected: wrong tone/);
    });

    it('getThread returns null for a non-existent conversation', async () => {
      assert.equal(await mod.getThread(randomUUID()), null);
    });
  },
);
