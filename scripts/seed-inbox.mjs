// Seed a handful of realistic Inbox conversations (PRD-02 §F5.3).
//
//   npm run seed-inbox            # replace the seeded threads (idempotent)
//   npm run seed-inbox -- --clear # remove them and stop
//
// Messaging inbound is otherwise only reachable through the channel simulator
// (app/api/inbox/simulate, §F5.11) because the Twilio Sandbox is unconfigured;
// this gives the surface some history to open onto — resolved threads, an open
// one, a held AI draft awaiting approval, and one unknown-contact message that
// never resolved to a customer (the §F5.4 queue).
//
// Idempotent: every row's id is UUIDv5(seed + logical key), and the script
// deletes its own prior rows before re-inserting, so a re-run leaves exactly
// one copy and never touches customer/order rows.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inArray, sql, isNull, eq } from 'drizzle-orm';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const CLEAR = process.argv.slice(2).includes('--clear');
const SEED = 'inbox-20260907';
const NS = createHash('sha1').update(`cadence-seed:${SEED}`).digest().subarray(0, 16);
function uuid5(name) {
  const h = createHash('sha1').update(NS).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const { db, schema } = await import('../db/index.js');
const { conversations, messages, customers } = schema;

// A few real seeded customers to hang threads on — need a phone for WA/SMS.
const pool = await db
  .select({ id: customers.id, first: customers.firstName, last: customers.lastName, email: customers.email })
  .from(customers)
  .where(sql`${customers.phoneE164} is not null and ${customers.email} is not null`)
  .orderBy(customers.firstName)
  .limit(5);

if (pool.length < 4) {
  console.error('Not enough seeded customers with phone + email. Run `npm run seed` first.');
  process.exit(1);
}

// ── thread definitions ──────────────────────────────────────────────────────
// t: minutes-ago offsets get older first. status held => AI draft awaiting review.
const THREADS = [
  {
    key: 'wa-order-status',
    channel: 'whatsapp',
    customer: pool[0],
    status: 'open',
    intent: 'order_status',
    summary: 'Asking where a delayed dining set is',
    msgs: [
      { dir: 'inbound', ago: 3 * HOUR, body: 'Hi, my dining table order #1042 was supposed to arrive Monday. Any update?' },
      { dir: 'outbound', ago: 3 * HOUR - 40 * MIN, body: 'Hi Priya, sorry about that — I can see it left the Jaipur warehouse Tuesday and is out for delivery today. You should have it by 7pm.', ai: true, editedPct: '18.00' },
      { dir: 'inbound', ago: 2 * HOUR, body: 'Thanks! Will someone call before they arrive?' },
    ],
  },
  {
    key: 'wa-return-held-draft',
    channel: 'whatsapp',
    customer: pool[1],
    status: 'pending',
    intent: 'return_request',
    summary: 'Cracked chair leg — wants a replacement',
    msgs: [
      { dir: 'inbound', ago: 90 * MIN, body: 'One of the four chairs from my order arrived with a cracked front leg. I want a replacement, not a refund.' },
      // held AI draft — the demo's approve/reject target
      { dir: 'outbound', ago: 80 * MIN, body: "Hi, I'm really sorry the chair arrived damaged. I've logged a replacement for the single chair and it will ship from our Jaipur warehouse within 3–4 working days at no cost to you. You don't need to send the damaged one back — our delivery team will collect it when they bring the new one. I'll share the dispatch confirmation here as soon as it's on the way.", ai: true, held: true },
    ],
  },
  {
    key: 'email-product-question',
    channel: 'email',
    customer: pool[2],
    status: 'resolved',
    intent: 'product_question',
    summary: 'Rug sizing question — answered',
    msgs: [
      { dir: 'inbound', ago: 5 * DAY, body: 'Do you make the Jaipur dhurrie rug in anything larger than 6x9? Our living room is quite big.' },
      { dir: 'outbound', ago: 5 * DAY - 2 * HOUR, body: 'Hello,\n\nThe Jaipur dhurrie comes in 6x9 as standard, and we can do an 8x10 as a made-to-order piece with a 5–6 week lead time. Happy to send a quote if that size works for you.\n\n— HomeStyle Customer Care', ai: true, editedPct: '42.00', external: 'resend_seed_demo_01' },
      { dir: 'inbound', ago: 4 * DAY, body: 'That works, please send the quote.' },
      { dir: 'outbound', ago: 4 * DAY - 90 * MIN, body: 'Quote sent to this address just now. Let me know if you have any questions.', ai: false, external: 'resend_seed_demo_02' },
    ],
  },
  {
    key: 'sms-complaint',
    channel: 'sms',
    customer: pool[3],
    status: 'open',
    intent: 'complaint',
    summary: 'Missed delivery window, frustrated',
    msgs: [
      { dir: 'inbound', ago: 26 * HOUR, body: 'Second time the delivery has been a no-show with no call. This is really poor.' },
      { dir: 'outbound', ago: 25 * HOUR, body: 'I completely understand the frustration and I\'m sorry. I\'ve escalated this to the Delhi dispatch lead and asked them to call you within the hour to lock a firm slot.', ai: true, editedPct: '55.00' },
    ],
  },
  {
    key: 'wa-unknown-contact',
    channel: 'whatsapp',
    customer: null,
    externalRef: '+919812300456', // deliberately not a seeded customer's number
    status: 'open',
    intent: null,
    summary: null,
    msgs: [
      { dir: 'inbound', ago: 45 * MIN, body: 'is this homestyle furniture? do you deliver to Chandigarh' },
    ],
  },
];

const convIds = THREADS.map((t) => uuid5(`conv:${t.key}`));

// ── clear prior seeded rows ─────────────────────────────────────────────────
await db.delete(messages).where(inArray(messages.conversationId, convIds));
await db.delete(conversations).where(inArray(conversations.id, convIds));
console.log(`Cleared ${convIds.length} prior seeded threads.`);

if (CLEAR) {
  console.log('--clear: done.');
  process.exit(0);
}

// ── insert ──────────────────────────────────────────────────────────────────
for (const t of THREADS) {
  const id = uuid5(`conv:${t.key}`);
  const ordered = [...t.msgs].sort((a, b) => b.ago - a.ago);
  const lastInbound = ordered.filter((m) => m.dir === 'inbound').at(-1);
  const last = ordered.at(-1);

  await db.insert(conversations).values({
    id,
    customerId: t.customer ? t.customer.id : null,
    channel: t.channel,
    externalRef: t.customer ? null : (t.externalRef ?? null),
    status: t.status,
    intentTag: t.intent,
    summary: t.summary,
    lastInboundAt: lastInbound ? new Date(NOW - lastInbound.ago) : null,
    lastMessageAt: last ? new Date(NOW - last.ago) : null,
  });

  for (const m of ordered) {
    await db.insert(messages).values({
      conversationId: id,
      direction: m.dir,
      body: m.body,
      status:
        m.dir === 'inbound'
          ? 'delivered'
          : m.held
            ? 'held'
            : 'sent',
      heldReason: m.held ? 'awaiting_approval' : null,
      externalId: m.external ?? null,
      aiGenerated: !!m.ai,
      aiEditedPct: m.editedPct ?? null,
      sentAt: m.dir === 'outbound' && !m.held ? new Date(NOW - m.ago) : null,
      createdAt: new Date(NOW - m.ago),
    });
  }
  console.log(`  ✓ ${t.key.padEnd(24)} ${t.channel.padEnd(9)} ${ordered.length} msgs${t.msgs.some((m) => m.held) ? '  (held draft)' : ''}`);
}

const [{ c }] = await db.select({ c: sql`count(*)::int` }).from(conversations);
const [{ h }] = await db.select({ h: sql`count(*)::int` }).from(messages).where(eq(messages.status, 'held'));
const [{ u }] = await db
  .select({ u: sql`count(*)::int` })
  .from(conversations)
  .where(isNull(conversations.customerId));
console.log(`\nDone. conversations=${c}  held drafts=${h}  unknown contacts=${u}`);
process.exit(0);
