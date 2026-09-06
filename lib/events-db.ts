// Database side of the storefront event endpoint (PRD-01 §7, task-9-brief.md).
//
// Split from lib/events.ts for the same reason lib/shopify-sync.ts is split
// from lib/shopify-webhook.ts: db/index.ts throws at import time when
// DATABASE_URL is unset, so the pure validation stays importable (and
// unit-testable) without it.
//
// Deliberately NOT `import 'server-only'` (unlike lib/queries.ts): that
// package throws outside a React server bundle, which would make this module
// unimportable from tests/events-db.test.ts.
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index';
import type { EventInput } from './events';

const { customers, events } = schema;

/**
 * Resolve a Shopify customer id (as sent by the theme's tracking snippet —
 * see homestyle-theme/snippets/cadence-tracking.liquid) to this CRM's internal
 * customers.id. Read-only: an event never creates a customer row, unlike the
 * Shopify webhook path (lib/shopify-sync.ts upsertCustomer) — a storefront
 * visitor Shopify hasn't told us about yet just gets a null customer_id,
 * same as an anonymous/logged-out visit.
 */
export async function resolveCustomerId(
  shopifyCustomerId: number | null,
): Promise<string | null> {
  if (shopifyCustomerId === null) return null;
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.shopifyCustomerId, shopifyCustomerId))
    .limit(1);
  return row?.id ?? null;
}

export interface InsertedEvent {
  id: string;
  customerId: string | null;
}

/** Insert one event row. Always a plain insert — this endpoint has no notion of "the same event twice", unlike checkout_started/_updated from the Shopify webhook (lib/shopify-sync.ts recordCheckout), which dedupes on checkout_id. */
export async function insertEvent(input: EventInput): Promise<InsertedEvent> {
  const customerId = await resolveCustomerId(input.shopifyCustomerId);

  const [row] = await db
    .insert(events)
    .values({
      customerId,
      sessionId: input.sessionId,
      type: input.type,
      payload: { ...input.payload, source: input.source },
      occurredAt: input.occurredAt,
    })
    .returning({ id: events.id, customerId: events.customerId });

  return { id: row.id, customerId: row.customerId };
}

export interface RecentEvent {
  id: string;
  type: string;
  sessionId: string | null;
  customerId: string | null;
  payload: unknown;
  occurredAt: Date;
}

/** Most recent events, newest first — backs the simulator page's "landed in the database" proof and the endpoint's own GET for smoke-testing. */
export async function getRecentEvents(limit = 20): Promise<RecentEvent[]> {
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      sessionId: events.sessionId,
      customerId: events.customerId,
      payload: events.payload,
      occurredAt: events.occurredAt,
    })
    .from(events)
    .orderBy(desc(events.occurredAt))
    .limit(limit);
  return rows;
}
