// The agent's world: the four views `cadence_agent` may read, their real
// columns, and the real values in them.
//
// EVERY column, type, enum value and row count below was read out of the live
// database on 2026-08-29 by connecting as cadence_agent itself and querying
// information_schema.columns / pg_enum / the views themselves. Nothing here is
// copied from a spec. PRD-02 §F4.8 asks for few-shot examples written against
// the actual schema, and an example that references a column which does not
// exist is worse than no example at all — the model imitates it and every
// query it writes afterwards fails.
//
// Pure data, no imports: lib/agent/sql-guard.ts and tests both depend on it.

export const AGENT_VIEWS = [
  'v_customer_360',
  'v_order_facts',
  'v_customer_scores',
  'v_conversation_summary',
] as const;

export type AgentView = (typeof AGENT_VIEWS)[number];

export const SEGMENT_VALUES = [
  'champions', 'loyal', 'potential_loyalist', 'new_customer', 'promising',
  'need_attention', 'about_to_sleep', 'at_risk', 'cant_lose_them',
  'hibernating', 'lost',
] as const;

export const FINANCIAL_STATUS_VALUES = [
  'pending', 'authorized', 'paid', 'partially_refunded', 'refunded',
  'voided', 'cancelled',
] as const;

export const COLLECTION_VALUES = ['skin-care', 'hair-care', 'wellness'] as const;

type ViewSpec = {
  /** Live row count at introspection time, and what the view is for. */
  note: string;
  /** column name -> Postgres type, plus a short note where the type is not enough. */
  columns: Record<string, string>;
};

export const VIEW_CATALOGUE: Record<AgentView, ViewSpec> = {
  v_customer_360: {
    note:
      'One row per customer (800 rows). PII is deliberately masked: there is no ' +
      'phone or email column, only has_phone/has_email booleans, and ' +
      'customer_name is abbreviated ("Ananya R."). This is by design.',
    columns: {
      customer_id: 'uuid',
      customer_name: 'text — abbreviated, e.g. "Ananya R."',
      city: 'text — 22 distinct, e.g. Visakhapatnam, Jaipur, Surat, Delhi, Bengaluru',
      state: 'text — 15 distinct, e.g. Kerala, Delhi, Karnataka',
      customer_since: 'timestamptz',
      has_phone: 'boolean — whether a phone number exists; the number itself is not exposed',
      has_email: 'boolean — whether an email exists; the address itself is not exposed',
      segment: 'segment_t enum',
      churn_risk: 'smallint 0-100, higher is worse',
      churn_reason: 'text — human-readable explanation of churn_risk',
      predicted_ltv: 'numeric(12,2) INR',
      next_order_date: 'date — predicted next order',
      median_interval_days: 'numeric — this customer\u2019s own typical gap between orders',
      days_since_last_order: 'integer',
      order_count: 'integer',
      lifetime_value: 'numeric(12,2) INR — revenue to date',
      aov: 'numeric(12,2) INR — average order value',
      consent_whatsapp: 'boolean',
      consent_email: 'boolean',
    },
  },
  v_order_facts: {
    note:
      'One row per order (2,780 rows), processed_at spans 2025-03-21 to 2026-08-19. ' +
      'Join to customers on customer_id.',
    columns: {
      order_id: 'uuid',
      order_number: 'text — e.g. "#RSY-11902"',
      customer_id: 'uuid — joins v_customer_360.customer_id / v_customer_scores.customer_id',
      total: 'numeric(12,2) INR',
      discount_total: 'numeric(12,2) INR',
      discount_codes: 'text[] — e.g. WELCOME10, WINBACK15, RASAYA5, FESTIVE20, DIWALI15',
      currency: 'text — always INR',
      financial_status: 'financial_status_t enum — live data is only paid (2,743) and partially_refunded (37)',
      processed_at: 'timestamptz',
      cancelled_at: 'timestamptz — null unless cancelled',
      line_count: 'bigint — distinct line items on the order',
      unit_count: 'bigint — total units',
      collections: 'text[] — only skin-care, hair-care, wellness',
      product_titles: 'text[] — e.g. "Rosemary Scalp Serum", "Bhringraj Anti-Hairfall Hair Oil"',
    },
  },
  v_customer_scores: {
    note:
      'One row per scored customer (800 rows). Superset of the score columns in ' +
      'v_customer_360, and the only place the *_reason narratives live. Use this ' +
      'when the question is about why a score is what it is; use v_customer_360 ' +
      'when the question also needs city/state/consent.',
    columns: {
      customer_id: 'uuid',
      segment: 'segment_t enum',
      rfm_r: 'smallint 1-5 (recency)',
      rfm_f: 'smallint 1-5 (frequency)',
      rfm_m: 'smallint 1-5 (monetary)',
      churn_risk: 'smallint 0-100',
      churn_reason: 'text',
      predicted_ltv: 'numeric(12,2) INR',
      ltv_reason: 'text — how predicted_ltv was derived',
      next_order_date: 'date',
      next_order_reason: 'text — why that date',
      median_interval_days: 'numeric',
      days_since_last_order: 'integer',
      order_count: 'integer',
      lifetime_value: 'numeric(12,2) INR',
      aov: 'numeric(12,2) INR',
      computed_at: 'timestamptz — when the score was last recomputed',
    },
  },
  v_conversation_summary: {
    note:
      'EMPTY — 0 rows. Messaging (PRD-02 §F5) is blocked on Twilio, so ' +
      'conversations and messages have never been written to. Any question ' +
      'about conversations, replies or WhatsApp threads will correctly return ' +
      'nothing; say so rather than inventing an answer.',
    columns: {
      conversation_id: 'uuid',
      customer_id: 'uuid',
      channel: 'channel_t enum: whatsapp, email, sms',
      status: 'conv_status_t enum: open, pending, resolved, snoozed',
      intent_tag: 'text',
      summary: 'text',
      last_inbound_at: 'timestamptz',
      last_message_at: 'timestamptz',
      message_count: 'bigint',
      inbound_count: 'bigint',
      outbound_count: 'bigint',
      held_count: 'bigint',
      session_open: 'boolean',
    },
  },
};

/**
 * Every column name across the four views. Used by the guard to tell a real
 * table reference apart from `extract(month from processed_at)`, where the
 * token after FROM is a column, not a relation.
 */
export const KNOWN_COLUMNS: ReadonlySet<string> = new Set(
  Object.values(VIEW_CATALOGUE).flatMap((v) => Object.keys(v.columns)),
);
