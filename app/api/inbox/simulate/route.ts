// Channel simulator (PRD-02 §F5.11) — an in-app fake WhatsApp / email / SMS
// client posting to the same inbound path the real Twilio/Resend webhooks would
// use, for deterministic demos independent of network conditions. The Twilio
// Sandbox is not configured (PRD-02 Deferred), so this is currently the ONLY
// way an inbound message enters the system.
//
// POST: land one inbound message (lib/inbox-db.recordInboundMessage), optionally
//       generate a held AI draft reply (lib/inbox-draft.generateReplyDraft).
// GET:  list conversations, so the simulator UI can refresh without a full nav.
//
// No HMAC — there is no signed real webhook to mirror yet, and this endpoint is
// same-origin from the Inbox page. Same posture as /api/events: an allow-listed
// shape (lib/inbox-input) plus a per-IP rate limit.
import { NextResponse } from 'next/server';
import { checkRateLimit, clientKey, INBOX_RATE_LIMIT } from '../../../../lib/agent/rate-limit';
import { parseSimulateInput } from '../../../../lib/inbox-input';
import {
  getThread,
  insertOutboundDraft,
  listConversations,
  recordInboundMessage,
  setConversationIntent,
  type Channel,
  type ConvStatus,
} from '../../../../lib/inbox-db';
import { generateReplyDraft } from '../../../../lib/inbox-draft';
import { generateReplyDraftViaN8n } from '../../../../lib/inbox-draft-via-n8n';
import { db, schema } from '../../../../db/index';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const limit = checkRateLimit(`inbox:${clientKey(request)}`, Date.now(), INBOX_RATE_LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'rate limit reached' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'request body is not valid JSON' }, { status: 400 });
  }

  const parsed = parseSimulateInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }
  const input = parsed.value;

  try {
    const inbound = await recordInboundMessage({
      channel: input.channel,
      body: input.body,
      phone: input.phone,
      email: input.email,
      customerId: input.customerId,
    });

    let draftId: string | null = null;
    let intent: string | null = null;
    if (input.autoDraft) {
      let customerName: string | null = null;
      if (inbound.customerId) {
        const [c] = await db
          .select({ firstName: schema.customers.firstName, lastName: schema.customers.lastName })
          .from(schema.customers)
          .where(eq(schema.customers.id, inbound.customerId))
          .limit(1);
        customerName = [c?.firstName, c?.lastName].filter(Boolean).join(' ') || null;
      }
      // INBOX_DRAFT_VIA_N8N_WEBHOOK is a demo-only toggle: when set, drafts
      // route through n8n's own copy of this logic (workflow 05) instead of
      // running in-process, so it shows up as a live execution in n8n's UI.
      // Unset in every normal deployment -- see lib/inbox-draft-via-n8n.ts.
      const draftCtx = {
        conversationId: inbound.conversationId,
        customerId: inbound.customerId,
        customerName,
        channel: input.channel,
        inboundBody: input.body,
      };
      const draft = process.env.INBOX_DRAFT_VIA_N8N_WEBHOOK
        ? await generateReplyDraftViaN8n(draftCtx)
        : await generateReplyDraft(draftCtx);
      const inserted = await insertOutboundDraft({
        conversationId: inbound.conversationId,
        body: draft.reply,
        aiGenerated: draft.aiGenerated,
      });
      draftId = inserted.id;
      intent = draft.intent;
      if (draft.intent) await setConversationIntent(inbound.conversationId, draft.intent);
    }

    return NextResponse.json(
      {
        ok: true,
        conversationId: inbound.conversationId,
        customerId: inbound.customerId,
        matched: inbound.matched,
        newConversation: inbound.newConversation,
        draftId,
        intent,
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[inbox] simulate failed', err);
    return NextResponse.json({ ok: false, error: 'failed to record inbound message' }, { status: 500 });
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const conversationId = url.searchParams.get('conversation');
  if (conversationId) {
    try {
      const thread = await getThread(conversationId);
      if (!thread) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
      return NextResponse.json({ ok: true, thread });
    } catch (err) {
      console.error('[inbox] thread fetch failed', err);
      return NextResponse.json({ ok: false, error: 'failed to load thread' }, { status: 500 });
    }
  }

  const statusParam = url.searchParams.get('status');
  const channelParam = url.searchParams.get('channel');
  try {
    const rows = await listConversations({
      status: (statusParam as ConvStatus) || undefined,
      channel: (channelParam as Channel) || undefined,
      assignment: url.searchParams.get('assignment') === 'unassigned' ? 'unassigned' : undefined,
      q: url.searchParams.get('q') || undefined,
    });
    return NextResponse.json({ ok: true, conversations: rows });
  } catch (err) {
    console.error('[inbox] list failed', err);
    return NextResponse.json({ ok: false, error: 'failed to list conversations' }, { status: 500 });
  }
}
