// Pure, dependency-free validation for the storefront event tracking endpoint
// (PRD-01 §7, task-9-brief.md). Mirrors the split used for the Shopify
// webhook (lib/shopify-webhook.ts / lib/shopify-sync.ts): nothing here
// touches next/* or the database, so it can be unit-tested as plain
// functions without DATABASE_URL or a running server.
//
// Two callers post here: the Dawn theme's tracking snippet
// (homestyle-theme/snippets/cadence-tracking.liquid + assets/cadence-tracking.js)
// and the in-app event simulator (app/simulator) — both send the identical
// wire shape, so this validator is the single source of truth for both.

// The four types PRD-01 §7 asks the storefront to emit. `events.type` is a
// plain text column with no DB-level enum (confirmed live — see db/schema.ts),
// so nothing stops a future caller sending a fifth type; this endpoint keeps
// the allow-list tight on purpose, since it is reachable from the open
// internet with no auth once a store is public.
export const TRACKED_EVENT_TYPES = [
  'page_view',
  'product_view',
  'add_to_cart',
  'checkout_started',
] as const;

export type TrackedEventType = (typeof TRACKED_EVENT_TYPES)[number];

export function isTrackedEventType(type: unknown): type is TrackedEventType {
  return (
    typeof type === 'string' &&
    (TRACKED_EVENT_TYPES as readonly string[]).includes(type)
  );
}

export interface EventInput {
  type: TrackedEventType;
  /** Shopify's numeric customer id, if the visitor is a logged-in customer. Resolved to an internal customers.id by lib/events-db.ts. */
  shopifyCustomerId: number | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  /** Set by the caller (route.ts), not accepted from the request body — see parseEventInput. */
  source: 'storefront_pixel' | 'simulator';
}

export type ParseResult =
  | { ok: true; value: EventInput }
  | { ok: false; error: string };

// A payload this large is either abuse or a bug on the sending side — 8KB is
// generous for the four shapes this endpoint actually receives (product
// title/price/handle, a cart source string, a page URL/title).
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_SESSION_ID_LEN = 128;

/**
 * Validate and normalise a decoded JSON request body. `source` is supplied by
 * the caller (route.ts derives it from a request header) rather than read from
 * the body, so a body field cannot set it by accident. This is NOT a trust
 * boundary — the endpoint is unauthenticated and the header is caller-supplied,
 * so either value can be spoofed. See app/api/events/route.ts.
 */
export function parseEventInput(
  body: unknown,
  source: EventInput['source'],
): ParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  if (!isTrackedEventType(b.type)) {
    return {
      ok: false,
      error: `"type" must be one of: ${TRACKED_EVENT_TYPES.join(', ')}`,
    };
  }

  let shopifyCustomerId: number | null = null;
  if (b.customer_id !== undefined && b.customer_id !== null) {
    const n =
      typeof b.customer_id === 'number' ? b.customer_id : Number(b.customer_id);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: '"customer_id" must be a positive integer or null' };
    }
    shopifyCustomerId = n;
  }

  let sessionId: string | null = null;
  if (b.session_id !== undefined && b.session_id !== null) {
    if (typeof b.session_id !== 'string' || b.session_id.length === 0) {
      return { ok: false, error: '"session_id" must be a non-empty string or null' };
    }
    if (b.session_id.length > MAX_SESSION_ID_LEN) {
      return { ok: false, error: `"session_id" exceeds ${MAX_SESSION_ID_LEN} characters` };
    }
    sessionId = b.session_id;
  }

  let payload: Record<string, unknown> = {};
  if (b.payload !== undefined) {
    if (typeof b.payload !== 'object' || b.payload === null || Array.isArray(b.payload)) {
      return { ok: false, error: '"payload" must be a JSON object' };
    }
    const encoded = JSON.stringify(b.payload);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) {
      return { ok: false, error: `"payload" exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    }
    payload = b.payload as Record<string, unknown>;
  }

  let occurredAt = new Date();
  if (b.occurred_at !== undefined && b.occurred_at !== null) {
    if (typeof b.occurred_at !== 'string') {
      return { ok: false, error: '"occurred_at" must be an ISO 8601 string' };
    }
    const d = new Date(b.occurred_at);
    if (Number.isNaN(d.getTime())) {
      return { ok: false, error: '"occurred_at" is not a valid date' };
    }
    occurredAt = d;
  }

  return {
    ok: true,
    value: { type: b.type, shopifyCustomerId, sessionId, payload, occurredAt, source },
  };
}
