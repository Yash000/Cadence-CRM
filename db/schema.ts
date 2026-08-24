// Drizzle definitions mirroring the live Postgres schema (PRD-02 §5).
//
// This file is a MIRROR, not a design. The database already exists (Supabase
// project pldjtgzmwtgrlyygslvl) and is authoritative — every table, column,
// type, nullability, default and constraint here was confirmed by introspecting
// the live database on 2026-08-24 (information_schema + pg_catalog), not by
// reading a spec. If this file and the live database ever disagree, the
// database wins; fix this file, don't migrate the database to match it.
//
// Do NOT run `drizzle-kit push` or `drizzle-kit migrate` against this schema —
// drizzle.config.ts exists only so `drizzle-kit introspect`/studio can point at
// the DB; there is deliberately no migrations/ output wired into app startup.

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  smallint,
  bigint,
  numeric,
  jsonb,
  timestamp,
  date,
  vector,
  uniqueIndex,
  index,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Custom types
// ---------------------------------------------------------------------------

// Postgres `citext` (case-insensitive text) — used for customers.email so
// lookups/uniqueness ignore case. Drizzle has no built-in citext column type;
// this maps it straight through as a JS string.
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

// ---------------------------------------------------------------------------
// Enums — 10 confirmed in `public` via pg_type/pg_enum (the brief's task text
// says 11; re-introspected twice to be sure, only these 10 exist). All 10 are
// listed in the task-1 brief and every value below was read from the live
// enum, not guessed.
// ---------------------------------------------------------------------------

export const channelT = pgEnum('channel_t', ['whatsapp', 'email', 'sms']);

export const consentStatusT = pgEnum('consent_status_t', [
  'opted_in',
  'opted_out',
  'unknown',
]);

export const directionT = pgEnum('direction_t', ['inbound', 'outbound']);

// Segment order below is the RFM sort order used by the live enum
// (pg_enum.enumsortorder) — the scoring job in a later task writes these
// values verbatim, so the set must be exact even though order has no
// semantic meaning to Postgres.
export const segmentT = pgEnum('segment_t', [
  'champions',
  'loyal',
  'potential_loyalist',
  'new_customer',
  'promising',
  'need_attention',
  'about_to_sleep',
  'at_risk',
  'cant_lose_them',
  'hibernating',
  'lost',
]);

export const messageStatusT = pgEnum('message_status_t', [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'held',
]);

export const convStatusT = pgEnum('conv_status_t', [
  'open',
  'pending',
  'resolved',
  'snoozed',
]);

export const approvalStatusT = pgEnum('approval_status_t', [
  'approved',
  'pending',
  'rejected',
]);

export const taskStatusT = pgEnum('task_status_t', [
  'open',
  'in_progress',
  'done',
  'dismissed',
  'suppressed',
]);

export const campaignStatusT = pgEnum('campaign_status_t', [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'cancelled',
]);

export const financialStatusT = pgEnum('financial_status_t', [
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shopifyCustomerId: bigint('shopify_customer_id', { mode: 'number' }),
    email: citext('email'),
    // CHECK customers_phone_e164_format (DB-enforced, not expressible in Drizzle):
    //   phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
    phoneE164: text('phone_e164'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    city: text('city'),
    state: text('state'),
    country: text('country').default('IN'),
    acceptsMarketing: boolean('accepts_marketing').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('customers_phone_e164_key').on(t.phoneE164),
    uniqueIndex('customers_shopify_customer_id_key').on(t.shopifyCustomerId),
    index('customers_email_idx').on(t.email),
    index('customers_created_at_idx').on(t.createdAt),
    // customers_name_trgm_idx (gin/pg_trgm on a coalesced expression) is not
    // representable as a Drizzle column index; it exists in the DB already
    // and needs no application-side declaration.
  ],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shopifyProductId: bigint('shopify_product_id', { mode: 'number' }),
    title: text('title').notNull(),
    handle: text('handle'),
    collection: text('collection'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    // CHECK products_replenishment_days_check: replenishment_days IS NULL OR replenishment_days > 0
    replenishmentDays: integer('replenishment_days'),
    price: numeric('price', { precision: 12, scale: 2 }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('products_shopify_product_id_key').on(t.shopifyProductId),
    index('products_collection_idx').on(t.collection),
    // products_tags_idx is a GIN index over the array column; Drizzle can't
    // express the `USING gin` method via `.on()`, and it's DB-managed already.
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shopifyOrderId: bigint('shopify_order_id', { mode: 'number' }),
    orderNumber: text('order_number'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }),
    discountTotal: numeric('discount_total', { precision: 12, scale: 2 }).notNull().default('0'),
    discountCodes: text('discount_codes').array().notNull().default(sql`'{}'::text[]`),
    currency: text('currency').notNull().default('INR'),
    financialStatus: financialStatusT('financial_status').notNull().default('paid'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('orders_shopify_order_id_key').on(t.shopifyOrderId),
    index('orders_customer_processed_idx').on(t.customerId, t.processedAt),
    index('orders_processed_at_idx').on(t.processedAt),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
    variantId: bigint('variant_id', { mode: 'number' }),
    title: text('title'),
    // CHECK order_items_qty_check: qty > 0
    qty: integer('qty').notNull().default(1),
    price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    index('order_items_product_idx').on(t.productId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('events_customer_time_idx').on(t.customerId, t.occurredAt),
    index('events_type_time_idx').on(t.type, t.occurredAt),
    // events_payload_idx is a GIN index on jsonb payload — DB-managed, not
    // expressible as a plain column index here.
  ],
);

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    channel: channelT('channel').notNull(),
    status: consentStatusT('status').notNull().default('unknown'),
    source: text('source'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex('consents_customer_id_channel_key').on(t.customerId, t.channel),
    index('consents_customer_idx').on(t.customerId),
  ],
);

// customer_scores is a 1:1 extension of customers, keyed by customer_id (no
// separate `id` column) — written by the scoring job in a later task.
export const customerScores = pgTable(
  'customer_scores',
  {
    customerId: uuid('customer_id').primaryKey().references(() => customers.id, { onDelete: 'cascade' }),
    // CHECK customer_scores_rfm_r_check / _f_check / _m_check: each in [1,5]
    rfmR: smallint('rfm_r'),
    rfmF: smallint('rfm_f'),
    rfmM: smallint('rfm_m'),
    segment: segmentT('segment'),
    // CHECK customer_scores_churn_risk_check: churn_risk BETWEEN 0 AND 100
    churnRisk: smallint('churn_risk'),
    churnReason: text('churn_reason'),
    predictedLtv: numeric('predicted_ltv', { precision: 12, scale: 2 }),
    ltvReason: text('ltv_reason'),
    nextOrderDate: date('next_order_date'),
    nextOrderReason: text('next_order_reason'),
    medianIntervalDays: numeric('median_interval_days', { precision: 6, scale: 1 }),
    daysSinceLastOrder: integer('days_since_last_order'),
    orderCount: integer('order_count').notNull().default(0),
    lifetimeValue: numeric('lifetime_value', { precision: 12, scale: 2 }).notNull().default('0'),
    aov: numeric('aov', { precision: 12, scale: 2 }),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('customer_scores_churn_idx').on(t.churnRisk),
    index('customer_scores_segment_idx').on(t.segment),
  ],
);

export const segments = pgTable(
  'segments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    definition: jsonb('definition').notNull().default({}),
    isDynamic: boolean('is_dynamic').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex('segments_name_key').on(t.name)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    channel: channelT('channel').notNull(),
    externalRef: text('external_ref'),
    status: convStatusT('status').notNull().default('open'),
    assignee: text('assignee'),
    intentTag: text('intent_tag'),
    summary: text('summary'),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('conversations_customer_idx').on(t.customerId, t.lastMessageAt),
    index('conversations_status_idx').on(t.status, t.lastMessageAt),
    // conversations_channel_ref_idx is a partial unique index
    // (UNIQUE (channel, external_ref) WHERE external_ref IS NOT NULL) —
    // Drizzle's uniqueIndex().on() can't express the WHERE clause; it's
    // DB-managed already and enforced regardless of what the app declares.
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    direction: directionT('direction').notNull(),
    body: text('body'),
    templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
    status: messageStatusT('status').notNull().default('queued'),
    heldReason: text('held_reason'),
    externalId: text('external_id'),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    aiEditedPct: numeric('ai_edited_pct', { precision: 5, scale: 2 }),
    // pgvector, dimension 1536 (confirmed via pg_attribute.atttypmod) — OpenAI
    // text-embedding-3-small size. Nullable: only AI-drafted messages get one.
    embedding: vector('embedding', { dimensions: 1536 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    // messages_status_idx is a partial index (WHERE status IN (queued, held,
    // failed)) — DB-managed, not expressible via a plain column index here.
  ],
);

export const templates = pgTable(
  'templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    channel: channelT('channel').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    category: text('category'),
    approvalStatus: approvalStatusT('approval_status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex('templates_channel_name_key').on(t.channel, t.name)],
);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  segmentId: uuid('segment_id').references(() => segments.id, { onDelete: 'set null' }),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  channel: channelT('channel').notNull(),
  status: campaignStatusT('status').notNull().default('draft'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  stats: jsonb('stats').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    // CHECK tasks_priority_check: priority BETWEEN 1 AND 5
    priority: smallint('priority').notNull().default(3),
    status: taskStatusT('status').notNull().default('open'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('tasks_open_priority_idx').on(t.status, t.priority, t.createdAt)],
);

export const aiLogs = pgTable(
  'ai_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    outcome: text('outcome').notNull().default('success'),
    generatedSql: text('generated_sql'),
    error: text('error'),
    // FK confirmed live via pg_constraint (ai_logs_customer_id_fkey): ON DELETE
    // SET NULL, same pattern as every other customer_id FK in this schema —
    // a deleted customer nulls out past logs rather than blocking the delete
    // or orphaning the log row.
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index('ai_logs_created_idx').on(t.createdAt),
    index('ai_logs_feature_time_idx').on(t.feature, t.createdAt),
  ],
);

export const webhookLog = pgTable(
  'webhook_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    topic: text('topic').notNull(),
    shopifyId: text('shopify_id'),
    payload: jsonb('payload').notNull(),
    hmacValid: boolean('hmac_valid').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index('webhook_log_topic_time_idx').on(t.topic, t.receivedAt)],
  // webhook_log_unprocessed_idx (partial index WHERE processed_at IS NULL) is
  // DB-managed only, same reasoning as the other partial indexes above.
);
