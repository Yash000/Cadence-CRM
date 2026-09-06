// Database + pure logic behind the Inbox surface (PRD-02 §F5.3, §F5.9, §F5.10).
//
// Split from any `server-only` import for the same reason lib/events-db.ts is:
// db/index.ts throws at import time when DATABASE_URL is unset, but the pure
// helpers below (normaliseE164, sessionWindowOpen, fallbackDraft) must stay
// importable and unit-testable without a database.
//
// SCOPE. Outbound messaging is only partly unblocked: email can really send
// through Resend (lib/messaging.ts), WhatsApp/SMS are simulated because the
// Twilio Sandbox is still not configured (PRD-02 Deferred). Every write here is
// channel-agnostic; whether a send actually left the building is decided by
// lib/messaging.ts and recorded on the message row (external_id set = real,
// null = simulated) so the UI can be honest about it.
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';

const { conversations, messages, customers } = schema;

export type Channel = 'whatsapp' | 'email' | 'sms';
export type ConvStatus = 'open' | 'pending' | 'resolved' | 'snoozed';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'held';

// Twilio's session-window rule (PRD-02 §F5.6): outside 24h from the customer's
// last inbound message, only approved templates may be sent. Pure so the UI and
// any future send-guard agree on the same arithmetic.
export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function sessionWindowOpen(
  lastInboundAt: Date | string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!lastInboundAt) return false;
  const t = typeof lastInboundAt === 'string' ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (!Number.isFinite(t)) return false;
  return now - t < SESSION_WINDOW_MS;
}

/**
 * Best-effort E.164 normalisation for inbound identity resolution (§F5.4).
 * Mirrors the DB CHECK customers_phone_e164_format: ^\+[1-9][0-9]{7,14}$.
 * Returns null when the input cannot be made to fit — the caller then treats
 * the message as an unknown contact rather than guessing a match.
 */
export function normaliseE164(raw: string | null | undefined, defaultCc = '91'): string | null {
  if (!raw) return null;
  let s = raw.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    // A bare 10-digit number is assumed to be a local (India, +91) subscriber
    // number — the store is Indian and every seeded customer is +91.
    if (/^\d{10}$/.test(s)) s = `+${defaultCc}${s}`;
    else if (/^\d{11,15}$/.test(s)) s = `+${s}`;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/**
 * Templated reply used when the model is unavailable or errors — F5.9 asks for
 * an AI draft the rep edits before send; a deterministic stand-in keeps the
 * approve/reject flow demoable when OPENROUTER_API_KEY is absent.
 */
export function fallbackDraft(customerName: string | null, channel: Channel): string {
  const name = customerName?.split(' ')[0]?.trim() || 'there';
  const sign = channel === 'email' ? '\n\n— HomeStyle Customer Care' : ' — HomeStyle Care';
  return `Hi ${name}, thanks for reaching out. We've picked this up and someone from the HomeStyle team will follow up shortly with the details you need.${sign}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ConversationListRow {
  id: string;
  channel: Channel;
  status: ConvStatus;
  intentTag: string | null;
  summary: string | null;
  customerId: string | null;
  customerName: string | null;
  phoneE164: string | null;
  lastInboundAt: Date | null;
  lastMessageAt: Date | null;
  lastBody: string | null;
  lastDirection: 'inbound' | 'outbound' | null;
  messageCount: number;
  heldCount: number;
  sessionOpen: boolean;
}

export interface ConversationListFilter {
  status?: ConvStatus;
  channel?: Channel;
  /** 'unassigned' = the F5.4 unknown-contacts queue (customer_id IS NULL). */
  assignment?: 'unassigned';
  q?: string;
  limit?: number;
}

const lastMessageExpr = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;

export async function listConversations(
  filter: ConversationListFilter = {},
): Promise<ConversationListRow[]> {
  const { status, channel, assignment, q, limit = 60 } = filter;
  const conds = [];
  if (status) conds.push(eq(conversations.status, status));
  if (channel) conds.push(eq(conversations.channel, channel));
  if (assignment === 'unassigned') conds.push(isNull(conversations.customerId));
  if (q && q.trim()) {
    const needle = `%${q.trim()}%`;
    conds.push(
      or(
        ilike(
          sql`coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')`,
          needle,
        ),
        ilike(customers.phoneE164, needle),
        ilike(customers.email, needle),
        ilike(conversations.summary, needle),
      ),
    );
  }

  const rows = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      status: conversations.status,
      intentTag: conversations.intentTag,
      summary: conversations.summary,
      customerId: conversations.customerId,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phoneE164: customers.phoneE164,
      lastInboundAt: conversations.lastInboundAt,
      lastMessageAt: conversations.lastMessageAt,
      lastBody: sql<
        string | null
      >`(select m.body from ${messages} m where m.conversation_id = ${conversations.id} order by m.created_at desc limit 1)`,
      lastDirection: sql<
        'inbound' | 'outbound' | null
      >`(select m.direction from ${messages} m where m.conversation_id = ${conversations.id} order by m.created_at desc limit 1)`,
      messageCount: sql<number>`(select count(*)::int from ${messages} m where m.conversation_id = ${conversations.id})`,
      heldCount: sql<number>`(select count(*)::int from ${messages} m where m.conversation_id = ${conversations.id} and m.status = 'held')`,
    })
    .from(conversations)
    .leftJoin(customers, eq(customers.id, conversations.customerId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(lastMessageExpr))
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel as Channel,
    status: r.status as ConvStatus,
    intentTag: r.intentTag,
    summary: r.summary,
    customerId: r.customerId,
    customerName: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
    phoneE164: r.phoneE164,
    lastInboundAt: r.lastInboundAt,
    lastMessageAt: r.lastMessageAt,
    lastBody: r.lastBody,
    lastDirection: r.lastDirection,
    messageCount: r.messageCount ?? 0,
    heldCount: r.heldCount ?? 0,
    sessionOpen: sessionWindowOpen(r.lastInboundAt),
  }));
}

export interface ThreadMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  status: MessageStatus;
  heldReason: string | null;
  externalId: string | null;
  aiGenerated: boolean;
  aiEditedPct: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export interface ThreadView {
  conversation: {
    id: string;
    channel: Channel;
    status: ConvStatus;
    assignee: string | null;
    intentTag: string | null;
    summary: string | null;
    lastInboundAt: Date | null;
    lastMessageAt: Date | null;
    createdAt: Date;
    sessionOpen: boolean;
  };
  customer: {
    id: string;
    name: string | null;
    email: string | null;
    phoneE164: string | null;
    city: string | null;
    acceptsMarketing: boolean;
  } | null;
  messages: ThreadMessage[];
}

export async function getThread(conversationId: string): Promise<ThreadView | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return null;

  let customer: ThreadView['customer'] = null;
  if (conv.customerId) {
    const [c] = await db
      .select({
        id: customers.id,
        firstName: customers.firstName,
        lastName: customers.lastName,
        email: customers.email,
        phoneE164: customers.phoneE164,
        city: customers.city,
        acceptsMarketing: customers.acceptsMarketing,
      })
      .from(customers)
      .where(eq(customers.id, conv.customerId))
      .limit(1);
    if (c) {
      customer = {
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
        email: c.email,
        phoneE164: c.phoneE164,
        city: c.city,
        acceptsMarketing: c.acceptsMarketing,
      };
    }
  }

  const msgs = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      body: messages.body,
      status: messages.status,
      heldReason: messages.heldReason,
      externalId: messages.externalId,
      aiGenerated: messages.aiGenerated,
      aiEditedPct: messages.aiEditedPct,
      sentAt: messages.sentAt,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);

  return {
    conversation: {
      id: conv.id,
      channel: conv.channel as Channel,
      status: conv.status as ConvStatus,
      assignee: conv.assignee,
      intentTag: conv.intentTag,
      summary: conv.summary,
      lastInboundAt: conv.lastInboundAt,
      lastMessageAt: conv.lastMessageAt,
      createdAt: conv.createdAt,
      sessionOpen: sessionWindowOpen(conv.lastInboundAt),
    },
    customer,
    messages: msgs.map((m) => ({
      id: m.id,
      direction: m.direction as 'inbound' | 'outbound',
      body: m.body,
      status: m.status as MessageStatus,
      heldReason: m.heldReason,
      externalId: m.externalId,
      aiGenerated: m.aiGenerated,
      aiEditedPct: m.aiEditedPct,
      sentAt: m.sentAt,
      createdAt: m.createdAt,
    })),
  };
}

export interface InboxCustomerOption {
  id: string;
  name: string;
  phoneE164: string | null;
  email: string | null;
}

/** Seeded customers the simulator can pose as — needs a phone (WhatsApp/SMS) or an email. */
export async function getInboxCustomerSample(limit = 24): Promise<InboxCustomerOption[]> {
  const rows = await db
    .select({
      id: customers.id,
      firstName: customers.firstName,
      lastName: customers.lastName,
      phoneE164: customers.phoneE164,
      email: customers.email,
    })
    .from(customers)
    .where(sql`${customers.phoneE164} is not null or ${customers.email} is not null`)
    .orderBy(sql`${customers.firstName} nulls last`)
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || r.id.slice(0, 8),
    phoneE164: r.phoneE164,
    email: r.email,
  }));
}

export interface InboxCounts {
  open: number;
  pending: number;
  heldDrafts: number;
  unassigned: number;
}

export async function getInboxCounts(): Promise<InboxCounts> {
  const [[openRow], [pendingRow], [heldRow], [unassignedRow]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.status, 'open')),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(eq(conversations.status, 'pending')),
    db.select({ n: sql<number>`count(*)::int` }).from(messages).where(eq(messages.status, 'held')),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(conversations)
      .where(isNull(conversations.customerId)),
  ]);
  return {
    open: openRow?.n ?? 0,
    pending: pendingRow?.n ?? 0,
    heldDrafts: heldRow?.n ?? 0,
    unassigned: unassignedRow?.n ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface InboundResult {
  conversationId: string;
  customerId: string | null;
  messageId: string;
  /** false = landed in the F5.4 unknown-contacts queue. */
  matched: boolean;
  /** true = a new conversation was opened for this message. */
  newConversation: boolean;
}

export interface RecordInboundInput {
  channel: Channel;
  body: string;
  /** Raw phone as typed by the simulator, or already-E.164. Ignored for email. */
  phone?: string | null;
  /** For email inbound. */
  email?: string | null;
  /** Explicit customer id from the simulator's picker — skips phone resolution. */
  customerId?: string | null;
}

/**
 * Land one inbound message: resolve the sender to a customer (§F5.4), attach it
 * to their most recent still-active conversation on this channel or open a new
 * one, and bump the session window.
 */
export async function recordInboundMessage(input: RecordInboundInput): Promise<InboundResult> {
  const now = new Date();
  const e164 = input.channel === 'email' ? null : normaliseE164(input.phone);
  const email = input.channel === 'email' ? input.email?.trim().toLowerCase() || null : null;

  let customerId = input.customerId ?? null;
  if (!customerId && e164) {
    const [c] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.phoneE164, e164))
      .limit(1);
    customerId = c?.id ?? null;
  }
  if (!customerId && email) {
    const [c] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, email))
      .limit(1);
    customerId = c?.id ?? null;
  }

  const externalRef = e164 ?? email ?? null;

  // Reuse an active thread rather than fragmenting one conversation into many.
  const reuseConds = [eq(conversations.channel, input.channel)];
  if (customerId) reuseConds.push(eq(conversations.customerId, customerId));
  else if (externalRef) reuseConds.push(eq(conversations.externalRef, externalRef));
  else reuseConds.push(sql`false`); // anonymous + no ref → always a fresh thread

  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(...reuseConds, sql`${conversations.status} <> 'resolved'`))
    .orderBy(desc(lastMessageExpr))
    .limit(1);

  let conversationId: string;
  let newConversation = false;
  if (existing) {
    conversationId = existing.id;
    await db
      .update(conversations)
      .set({
        lastInboundAt: now,
        lastMessageAt: now,
        updatedAt: now,
        status: 'open',
        ...(customerId ? { customerId } : {}),
      })
      .where(eq(conversations.id, conversationId));
  } else {
    const [created] = await db
      .insert(conversations)
      .values({
        customerId,
        channel: input.channel,
        externalRef,
        status: 'open',
        lastInboundAt: now,
        lastMessageAt: now,
      })
      .returning({ id: conversations.id });
    conversationId = created.id;
    newConversation = true;
  }

  const [msg] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'inbound',
      body: input.body,
      status: 'delivered',
      createdAt: now,
    })
    .returning({ id: messages.id });

  return {
    conversationId,
    customerId,
    messageId: msg.id,
    matched: customerId != null,
    newConversation,
  };
}

export interface DraftInput {
  conversationId: string;
  body: string;
  aiGenerated: boolean;
}

/** Insert an outbound AI draft in the `held` state — awaiting rep approval (§F5.9). */
export async function insertOutboundDraft(input: DraftInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      direction: 'outbound',
      body: input.body,
      status: 'held',
      heldReason: 'awaiting_approval',
      aiGenerated: input.aiGenerated,
    })
    .returning({ id: messages.id });
  await db
    .update(conversations)
    .set({ updatedAt: new Date(), status: 'pending' })
    .where(eq(conversations.id, input.conversationId));
  return { id: row.id };
}

export class DraftStateError extends Error {}

interface HeldDraft {
  id: string;
  conversationId: string;
  body: string | null;
  aiGenerated: boolean;
}

async function loadHeldDraft(messageId: string): Promise<HeldDraft> {
  const [m] = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      direction: messages.direction,
      status: messages.status,
      body: messages.body,
      aiGenerated: messages.aiGenerated,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!m) throw new DraftStateError('That draft no longer exists.');
  if (m.direction !== 'outbound') throw new DraftStateError('Only outbound drafts can be reviewed.');
  if (m.status !== 'held') throw new DraftStateError(`This message is already ${m.status}, not awaiting approval.`);
  return { id: m.id, conversationId: m.conversationId, body: m.body, aiGenerated: m.aiGenerated };
}

export interface ApproveInput {
  messageId: string;
  /** The rep's edited text, if they changed it before approving. */
  finalBody?: string;
  /** Provider id when a real send happened (Resend); null = simulated. */
  externalId?: string | null;
}

export interface ApproveResult {
  conversationId: string;
  body: string;
  simulated: boolean;
  aiEditedPct: number | null;
}

/**
 * Character-level edit distance as a percentage of the original length — the
 * §F5.9 "rep edits before send" signal, stored on ai_edited_pct so the AI
 * adoption metric (PRD-02 §F8) can tell an untouched draft from a rewritten one.
 */
export function editedPct(original: string, final: string): number {
  if (original === final) return 0;
  if (!original) return 100;
  const a = original;
  const b = final;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return Math.min(100, Math.round((dp[b.length] / a.length) * 100));
}

export async function approveDraft(input: ApproveInput): Promise<ApproveResult> {
  const draft = await loadHeldDraft(input.messageId);
  const original = draft.body ?? '';
  const finalBody = (input.finalBody ?? original).trim();
  const now = new Date();
  const pct = draft.aiGenerated ? editedPct(original, finalBody) : null;

  await db
    .update(messages)
    .set({
      body: finalBody,
      status: 'sent',
      heldReason: null,
      externalId: input.externalId ?? null,
      sentAt: now,
      aiEditedPct: pct == null ? null : pct.toFixed(2),
    })
    .where(eq(messages.id, draft.id));

  await db
    .update(conversations)
    .set({ lastMessageAt: now, updatedAt: now, status: 'open' })
    .where(eq(conversations.id, draft.conversationId));

  return {
    conversationId: draft.conversationId,
    body: finalBody,
    simulated: input.externalId == null,
    aiEditedPct: pct,
  };
}

export async function rejectDraft(messageId: string, reason: string): Promise<{ conversationId: string }> {
  const draft = await loadHeldDraft(messageId);
  const trimmed = reason.trim().slice(0, 300) || 'no reason given';
  await db
    .update(messages)
    .set({ status: 'failed', heldReason: `rejected: ${trimmed}` })
    .where(eq(messages.id, draft.id));
  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, draft.conversationId));
  return { conversationId: draft.conversationId };
}

export async function setConversationStatus(
  conversationId: string,
  status: ConvStatus,
): Promise<void> {
  await db
    .update(conversations)
    .set({ status, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/** §F5.10 intent tag — set once from the AI draft pass, not overwritten later. */
export async function setConversationIntent(
  conversationId: string,
  intentTag: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ intentTag, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.intentTag)));
}
