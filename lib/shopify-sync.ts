// Database side of the Shopify webhook endpoint (PRD-02 §F1, PRD-01 §6.3).
//
// Split from lib/shopify-webhook.ts so that the HMAC and normalisation logic
// stays importable without a DATABASE_URL. Everything here is written to be
// replay-safe: Shopify retries any delivery it does not get a 200 for within
// 5s, so the same payload arriving twice must converge on one row rather than
// two (PRD-02 §F1.4). That is achieved with the UNIQUE constraints already in
// the schema plus ON CONFLICT — never with a read-then-write existence check,
// which races with itself under concurrent retries.
// Deliberately NOT `import 'server-only'` (unlike lib/queries.ts): that
// package throws outside a React server bundle, which would make this module
// unimportable from tests/shopify-webhook-db.test.ts — and the idempotency
// guarantees below are only worth anything if they are tested against real
// UNIQUE constraints. Pulling this into a Client Component would fail loudly
// anyway, on db/index.ts's `pg` import.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import {
  buildCheckoutInput,
  buildCustomerInput,
  buildOrderInput,
  type CheckoutInput,
  type CustomerInput,
  type OrderInput,
  type ShopifyPayload,
  type ShopifyWebhookTopic,
} from './shopify-webhook';

const { consents, customers, events, orderItems, orders, products, webhookLog } = schema;

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// webhook_log (PRD-01 §6.3.4 — log BEFORE processing)
// ---------------------------------------------------------------------------

export interface WebhookLogInput {
  topic: string;
  shopifyId: string | null;
  payload: ShopifyPayload;
  hmacValid: boolean;
  /** Set for deliveries rejected before any processing (bad HMAC, bad JSON). */
  error?: string | null;
}

/**
 * Insert the receipt row. This runs for EVERY delivery, including ones that
 * fail HMAC verification and ones whose body will not parse — a rejected
 * delivery is precisely the one worth having a record of, and §F1.7's sync
 * health page reads this table.
 */
export async function logWebhook(input: WebhookLogInput): Promise<string> {
  const [row] = await db
    .insert(webhookLog)
    .values({
      topic: input.topic,
      shopifyId: input.shopifyId,
      payload: input.payload,
      hmacValid: input.hmacValid,
      error: input.error ?? null,
    })
    .returning({ id: webhookLog.id });
  return row.id;
}

/** Close out a log row once processing has finished (or failed). */
export async function markWebhookProcessed(
  logId: string,
  error?: string | null,
): Promise<void> {
  await db
    .update(webhookLog)
    .set({ processedAt: new Date(), error: error ?? null })
    .where(eq(webhookLog.id, logId));
}

// ---------------------------------------------------------------------------
// Identity resolution (PRD-02 §F1.5)
// ---------------------------------------------------------------------------

/**
 * Find the existing customer an inbound record belongs to.
 *
 * Order is phone, then email — phone first because `phone_e164` is the join
 * key to WhatsApp identity, and it is UNIQUE, so a hit is unambiguous. Email
 * is only indexed, not unique, so the oldest matching row wins to keep the
 * result deterministic. The Shopify customer id is tried last: it is the
 * strongest key when present, but §F1.5 asks specifically for contact-based
 * stitching, and a customer created by the bulk seed has a Shopify id that a
 * later webhook must be able to reach via phone.
 *
 * The caller must have normalised phone/email already.
 */
export async function resolveCustomerId(
  tx: Transaction,
  input: Pick<CustomerInput, 'phoneE164' | 'email' | 'shopifyCustomerId'>,
): Promise<string | null> {
  if (input.phoneE164) {
    const [byPhone] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.phoneE164, input.phoneE164))
      .limit(1);
    if (byPhone) return byPhone.id;
  }

  if (input.email) {
    const [byEmail] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.email, input.email))
      .orderBy(asc(customers.createdAt), asc(customers.id))
      .limit(1);
    if (byEmail) return byEmail.id;
  }

  if (input.shopifyCustomerId !== null) {
    const [byShopifyId] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.shopifyCustomerId, input.shopifyCustomerId))
      .limit(1);
    if (byShopifyId) return byShopifyId.id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Is this a Postgres unique-violation (SQLSTATE 23505)?
 *
 * Drizzle wraps driver errors, so the pg error with the `code` is somewhere
 * down the `cause` chain rather than on the error itself.
 */
export function isUniqueViolation(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; cursor !== null && cursor !== undefined && depth < 8; depth += 1) {
    if (typeof cursor === 'object' && (cursor as { code?: unknown }).code === '23505') return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Update an already-identified customer.
 *
 * Only values the payload actually carries are written: a webhook that omits a
 * field must not blank out data another source already filled in.
 * `shopify_customer_id` is written only when it is currently null, because
 * overwriting a different id would collide with its UNIQUE index.
 */
async function updateCustomer(
  tx: Transaction,
  customerId: string,
  input: CustomerInput,
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.email) patch.email = input.email;
  if (input.phoneE164) patch.phoneE164 = input.phoneE164;
  if (input.firstName) patch.firstName = input.firstName;
  if (input.lastName) patch.lastName = input.lastName;
  if (input.city) patch.city = input.city;
  if (input.state) patch.state = input.state;
  if (input.country) patch.country = input.country;
  patch.acceptsMarketing = input.acceptsMarketing;

  if (input.shopifyCustomerId !== null) {
    patch.shopifyCustomerId = sql`coalesce(${customers.shopifyCustomerId}, ${input.shopifyCustomerId})`;
  }

  await tx.update(customers).set(patch).where(eq(customers.id, customerId));
}

const CUSTOMER_CONFLICT_SET = {
  email: sql`coalesce(excluded.email, ${customers.email})`,
  phoneE164: sql`coalesce(excluded.phone_e164, ${customers.phoneE164})`,
  firstName: sql`coalesce(excluded.first_name, ${customers.firstName})`,
  lastName: sql`coalesce(excluded.last_name, ${customers.lastName})`,
  city: sql`coalesce(excluded.city, ${customers.city})`,
  state: sql`coalesce(excluded.state, ${customers.state})`,
  country: sql`coalesce(excluded.country, ${customers.country})`,
  acceptsMarketing: sql`excluded.accepts_marketing`,
};

/**
 * Insert a new customer, arbitrating on a UNIQUE index that can actually catch
 * a concurrent duplicate.
 *
 * `customers` has TWO unique indexes that matter here — `shopify_customer_id`
 * and `phone_e164` — and Postgres accepts only one arbiter per statement, so
 * the arbiter has to be chosen to match the payload:
 *
 * - Shopify id present: arbitrate on it. If the same delivery races itself,
 *   the loser's DO UPDATE rewrites the winner's row with identical values, so
 *   the phone index is never violated either.
 * - Shopify id NULL (an email/phone-only payload) but a phone present:
 *   arbitrate on `phone_e164`. NULL never conflicts, so arbitrating on the
 *   Shopify id here would catch nothing and the second concurrent insert would
 *   abort the transaction on `customers_phone_e164_key`.
 * - Neither: email only. `email` is deliberately NOT unique (one household can
 *   share an address), so there is no index to arbitrate on and none is
 *   wanted — a plain insert is correct.
 */
async function insertCustomer(tx: Transaction, input: CustomerInput): Promise<string> {
  const values = {
    shopifyCustomerId: input.shopifyCustomerId,
    email: input.email,
    phoneE164: input.phoneE164,
    firstName: input.firstName,
    lastName: input.lastName,
    city: input.city,
    state: input.state,
    country: input.country ?? 'IN',
    acceptsMarketing: input.acceptsMarketing,
  };
  const set = { ...CUSTOMER_CONFLICT_SET, updatedAt: new Date() };

  if (input.shopifyCustomerId !== null) {
    const [row] = await tx
      .insert(customers)
      .values(values)
      .onConflictDoUpdate({ target: customers.shopifyCustomerId, set })
      .returning({ id: customers.id });
    return row.id;
  }

  if (input.phoneE164) {
    const [row] = await tx
      .insert(customers)
      .values(values)
      .onConflictDoUpdate({ target: customers.phoneE164, set })
      .returning({ id: customers.id });
    return row.id;
  }

  const [row] = await tx.insert(customers).values(values).returning({ id: customers.id });
  return row.id;
}

/**
 * Insert, with a backstop for the one race the arbiter cannot cover: a payload
 * carrying BOTH a Shopify id and a phone, where some other writer takes that
 * phone between our resolve and our insert. The arbiter is the Shopify id, so
 * the phone index raises 23505 instead.
 *
 * The insert runs inside a SAVEPOINT (drizzle's nested transaction) precisely
 * so that failure does not poison the outer transaction — a 23505 marks a
 * Postgres transaction as aborted, and every later statement in it would fail
 * with "current transaction is aborted". Rolling back to the savepoint leaves
 * the outer transaction usable, and the customer is then re-resolved: whoever
 * won the race has committed a row we can find and update.
 */
async function insertCustomerRaceSafe(tx: Transaction, input: CustomerInput): Promise<string> {
  try {
    return await tx.transaction((sp) => insertCustomer(sp, input));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    const raced = await resolveCustomerId(tx, input);
    if (!raced) throw err;

    await updateCustomer(tx, raced, input);
    return raced;
  }
}

/**
 * Resolve-then-write a customer. Returns null when the payload carries no
 * identifying information at all (no Shopify id, no phone, no email) — there
 * is nothing to key a row on and inventing one would break idempotency.
 */
export async function upsertCustomer(
  tx: Transaction,
  input: CustomerInput,
): Promise<string | null> {
  if (input.shopifyCustomerId === null && !input.phoneE164 && !input.email) {
    return null;
  }

  // Resolve first (phone -> email -> Shopify id), which is what makes
  // SEQUENTIAL retries converge. The ON CONFLICT arbiter below is what makes
  // CONCURRENT retries converge — a retry storm is exactly when both matter.
  const existingId = await resolveCustomerId(tx, input);
  let customerId: string;

  if (existingId) {
    await updateCustomer(tx, existingId, input);
    customerId = existingId;
  } else {
    customerId = await insertCustomerRaceSafe(tx, input);
  }

  for (const consent of input.consents) {
    await tx
      .insert(consents)
      .values({
        customerId,
        channel: consent.channel,
        status: consent.status,
        source: 'shopify_webhook',
      })
      .onConflictDoUpdate({
        target: [consents.customerId, consents.channel],
        set: {
          status: consent.status,
          source: 'shopify_webhook',
          updatedAt: new Date(),
        },
      });
  }

  return customerId;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function upsertOrder(tx: Transaction, input: OrderInput): Promise<string> {
  if (input.shopifyOrderId === null) {
    // Without the id there is no unique key, so a retry would insert a second
    // row. Failing loudly (the error lands in webhook_log.error) is better
    // than silently creating duplicate revenue.
    throw new Error('order payload has no usable `id` — cannot upsert idempotently');
  }

  const customerId = await upsertCustomer(tx, input.customer);

  const [row] = await tx
    .insert(orders)
    .values({
      shopifyOrderId: input.shopifyOrderId,
      orderNumber: input.orderNumber,
      customerId,
      total: input.total,
      subtotal: input.subtotal,
      discountTotal: input.discountTotal,
      discountCodes: input.discountCodes,
      currency: input.currency,
      financialStatus: input.financialStatus,
      cancelledAt: input.cancelledAt,
      processedAt: input.processedAt,
    })
    .onConflictDoUpdate({
      target: orders.shopifyOrderId,
      set: {
        orderNumber: sql`coalesce(excluded.order_number, ${orders.orderNumber})`,
        // Never unlink an order from a customer we already resolved.
        customerId: sql`coalesce(excluded.customer_id, ${orders.customerId})`,
        total: sql`excluded.total`,
        subtotal: sql`coalesce(excluded.subtotal, ${orders.subtotal})`,
        discountTotal: sql`excluded.discount_total`,
        discountCodes: sql`excluded.discount_codes`,
        currency: sql`excluded.currency`,
        financialStatus: sql`excluded.financial_status`,
        cancelledAt: sql`excluded.cancelled_at`,
        processedAt: sql`excluded.processed_at`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: orders.id });

  const orderId = row.id;

  // order_items has no natural unique key across the pair (Shopify line item
  // ids are not stored), so the line set is replaced wholesale. Replacement is
  // idempotent by construction and also handles orders/updated changing a
  // quantity or removing a line.
  await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));

  if (input.lines.length > 0) {
    const shopifyProductIds = [
      ...new Set(
        input.lines
          .map((l) => l.shopifyProductId)
          .filter((id): id is number => id !== null),
      ),
    ];

    const productIdByShopifyId = new Map<number, string>();
    if (shopifyProductIds.length > 0) {
      const rows = await tx
        .select({ id: products.id, shopifyProductId: products.shopifyProductId })
        .from(products)
        .where(inArray(products.shopifyProductId, shopifyProductIds));
      for (const p of rows) {
        if (p.shopifyProductId !== null) productIdByShopifyId.set(p.shopifyProductId, p.id);
      }
    }

    await tx.insert(orderItems).values(
      input.lines.map((line) => ({
        orderId,
        // A product we have never seen (not in the catalogue seed) leaves
        // product_id null rather than dropping the line — the money still
        // belongs on the order.
        productId:
          line.shopifyProductId !== null
            ? (productIdByShopifyId.get(line.shopifyProductId) ?? null)
            : null,
        variantId: line.variantId,
        title: line.title,
        qty: line.qty,
        price: line.price,
      })),
    );
  }

  return orderId;
}

// ---------------------------------------------------------------------------
// Checkouts
// ---------------------------------------------------------------------------

/**
 * Checkouts land in `events`, which has no unique constraint to hang ON
 * CONFLICT off, so idempotency is enforced on (type, payload->>'checkout_id'):
 *
 * - `checkouts/create` -> `checkout_started`, inserted only if that checkout
 *   has no start event yet. The abandonment timer starts once (PRD-01 §6.2);
 *   a retry must not restart it.
 * - `checkouts/update` -> `checkout_updated`, which REPLACES any previous
 *   update event for the same checkout. That is the "abandonment timer resets"
 *   semantic: what matters is the latest state of the checkout, so a replay is
 *   a no-op and a genuine later update supersedes the earlier one.
 */
export async function recordCheckout(
  tx: Transaction,
  input: CheckoutInput,
): Promise<string | null> {
  const customerId = await upsertCustomer(tx, input.customer);

  const sameCheckout = and(
    eq(events.type, input.eventType),
    sql`${events.payload}->>'checkout_id' = ${input.checkoutId}`,
  );

  if (input.eventType === 'checkout_started') {
    const [existing] = await tx.select({ id: events.id }).from(events).where(sameCheckout).limit(1);
    if (existing) return existing.id;
  } else {
    await tx.delete(events).where(sameCheckout);
  }

  const [row] = await tx
    .insert(events)
    .values({
      customerId,
      sessionId: input.sessionId,
      type: input.eventType,
      payload: {
        checkout_id: input.checkoutId,
        value: input.value,
        items: input.itemCount,
        source: 'shopify_webhook',
      },
      occurredAt: input.occurredAt,
    })
    .returning({ id: events.id });

  return row.id;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ProcessResult {
  topic: ShopifyWebhookTopic;
  customerId?: string | null;
  orderId?: string;
  eventId?: string | null;
}

/**
 * Apply one verified webhook. Runs in a single transaction so a delivery is
 * either fully applied or not applied at all — a half-written order that a
 * Shopify retry then "upserts" onto would be worse than no order.
 */
export async function processWebhook(
  topic: ShopifyWebhookTopic,
  payload: ShopifyPayload,
): Promise<ProcessResult> {
  return db.transaction(async (tx) => {
    switch (topic) {
      case 'orders/create':
      case 'orders/updated':
      case 'orders/cancelled': {
        const input = buildOrderInput(payload);
        const orderId = await upsertOrder(tx, input);
        return { topic, orderId };
      }

      case 'customers/create':
      case 'customers/update': {
        const customerId = await upsertCustomer(tx, buildCustomerInput(payload));
        return { topic, customerId };
      }

      case 'checkouts/create':
      case 'checkouts/update': {
        const input = buildCheckoutInput(topic, payload);
        if (!input) {
          throw new Error('checkout payload has neither `id` nor `token` — cannot dedupe');
        }
        const eventId = await recordCheckout(tx, input);
        return { topic, eventId };
      }
    }
  });
}
