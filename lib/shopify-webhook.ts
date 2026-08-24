// Pure, dependency-free logic for the Shopify webhook endpoint (PRD-02 §F1,
// PRD-01 §6.2/§6.3).
//
// Nothing in this module touches the database or `next/*`. That is deliberate:
// db/index.ts throws at import time when DATABASE_URL is unset, so keeping the
// HMAC/normalisation/mapping logic here lets it be unit-tested as plain
// functions. The database side lives in lib/shopify-sync.ts.
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Topics (PRD-01 §6.2 — all seven, exactly)
// ---------------------------------------------------------------------------

export const SHOPIFY_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'customers/create',
  'customers/update',
  'checkouts/create',
  'checkouts/update',
] as const;

export type ShopifyWebhookTopic = (typeof SHOPIFY_WEBHOOK_TOPICS)[number];

export function isSupportedTopic(topic: string | null | undefined): topic is ShopifyWebhookTopic {
  return (
    typeof topic === 'string' && (SHOPIFY_WEBHOOK_TOPICS as readonly string[]).includes(topic)
  );
}

// ---------------------------------------------------------------------------
// HMAC (PRD-02 §F1.2, PRD-01 §6.3.1)
// ---------------------------------------------------------------------------

/**
 * Verify Shopify's `X-Shopify-Hmac-Sha256` header against the RAW request
 * body.
 *
 * `rawBody` is a Buffer of the exact bytes Shopify sent. It must never be a
 * re-serialisation of a parsed payload: `JSON.parse` followed by
 * `JSON.stringify` does not round-trip byte-identically (key order is
 * preserved but whitespace, number formatting and non-ASCII escaping are not),
 * so a digest over re-serialised JSON would reject every genuine delivery —
 * and would spuriously *pass* a test that re-serialised on both sides.
 *
 * Comparison is `crypto.timingSafeEqual`, not `===`, so the check does not
 * leak how many leading bytes of a forged signature were correct.
 */
export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!hmacHeader || !secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();

  // Buffer.from(x, 'base64') is lenient — it silently drops characters outside
  // the base64 alphabet rather than throwing — so garbage in the header
  // decodes to a short buffer instead of an error. The length check below is
  // what rejects it (and it also guards timingSafeEqual, which throws on
  // mismatched lengths).
  const provided = Buffer.from(hmacHeader, 'base64');
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(expected, provided);
}

/** Sign a raw body the way Shopify does. Used by tests and local tooling. */
export function signShopifyBody(rawBody: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

export type ShopifyPayload = Record<string, unknown>;

export type ParseResult =
  | { ok: true; value: ShopifyPayload }
  | { ok: false; error: string };

/**
 * Parse the raw body as a JSON object. Called only AFTER the HMAC digest has
 * been computed over the raw bytes.
 */
export function parsePayload(rawBody: Buffer): ParseResult {
  let text: string;
  try {
    text = rawBody.toString('utf8');
  } catch (err) {
    return { ok: false, error: `body is not valid UTF-8: ${errText(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `body is not valid JSON: ${errText(err)}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `expected a JSON object, got ${describe(parsed)}` };
  }

  return { ok: true, value: parsed as ShopifyPayload };
}

const RAW_LOG_LIMIT = 8192;

/**
 * What goes into `webhook_log.payload` (jsonb NOT NULL). A body that could not
 * be parsed still has to be logged — a rejected or malformed delivery is
 * exactly the one worth keeping — so it is wrapped as an object carrying a
 * truncated copy of the raw text and the parse error.
 */
export function webhookLogPayload(rawBody: Buffer, parsed: ParseResult): ShopifyPayload {
  if (parsed.ok) return parsed.value;
  const text = rawBody.toString('utf8');
  return {
    _unparsed: true,
    _parse_error: parsed.error,
    _raw_bytes: rawBody.length,
    _raw: text.length > RAW_LOG_LIMIT ? `${text.slice(0, RAW_LOG_LIMIT)}…[truncated]` : text,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---------------------------------------------------------------------------
// E.164 normalisation (PRD-02 §F1.5)
// ---------------------------------------------------------------------------

/**
 * `customers.phone_e164` is UNIQUE with a DB CHECK of
 * `^\+[1-9][0-9]{7,14}$`. Inbound Shopify payloads are not reliably formatted
 * that way — "+91 98765 43210", "098765 43210" and "9876543210" all occur —
 * so every phone is normalised before it is used as the identity key or
 * written.
 *
 * Returns null for anything that cannot be made into a valid E.164 number;
 * null means "no phone", never "write this as-is".
 */
const E164_RE = /^\+[1-9][0-9]{7,14}$/;

export function normalizeE164(
  input: unknown,
  defaultCallingCode = '91',
): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // "00" is the international access prefix — the same thing as a leading "+".
  const startsWithIddPrefix = digits.startsWith('00');
  const international = hasPlus || startsWithIddPrefix;
  const bare = startsWithIddPrefix ? digits.replace(/^0+/, '') : digits;
  if (!bare) return null;

  let candidate: string;
  if (international) {
    candidate = `+${bare}`;
  } else if (bare.length > 10 && bare.startsWith(defaultCallingCode)) {
    // Heuristic: a plus-less number that is longer than a national number and
    // already carries the country code (e.g. "919876543210") is international
    // with the "+" dropped, not a national number needing one prepended.
    candidate = `+${bare}`;
  } else {
    // National format. Strip trunk zeros before prepending the country code.
    const national = bare.replace(/^0+/, '');
    if (!national) return null;
    candidate = `+${defaultCallingCode}${national}`;
  }

  return E164_RE.test(candidate) ? candidate : null;
}

/** Emails are stored in a citext column; only whitespace/empties are cleaned. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

function obj(v: unknown): ShopifyPayload | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as ShopifyPayload) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Shopify ids are 64-bit integers; they arrive as numbers or numeric strings. */
export function toShopifyId(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** `webhook_log.shopify_id` — the resource id, as text, or null. */
export function extractShopifyId(payload: ShopifyPayload | null): string | null {
  if (!payload) return null;
  const id = toShopifyId(payload.id);
  if (id !== null) return String(id);
  // Checkouts also carry a `token`; fall back to it when `id` is absent.
  return str(payload.token);
}

function toTimestamp(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Money arrives as decimal strings ("1499.00"). They are kept as strings all
 * the way into the numeric(12,2) columns — parsing to a JS float and back is
 * how money picks up drift.
 */
const MONEY_RE = /^-?\d+(\.\d+)?$/;

export function toMoney(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v.toFixed(2);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return MONEY_RE.test(t) ? t : null;
}

/**
 * `financial_status_t` does not have a one-to-one mapping with Shopify's
 * financial states: Shopify has `partially_paid`, the enum does not, and the
 * enum has `cancelled`, which Shopify expresses via `cancelled_at` instead.
 */
const FINANCIAL_STATUSES = new Set([
  'pending',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'voided',
  'cancelled',
]);

export type FinancialStatus =
  | 'pending'
  | 'authorized'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'voided'
  | 'cancelled';

export function mapFinancialStatus(v: unknown): FinancialStatus {
  const s = str(v)?.toLowerCase();
  if (!s) return 'pending';
  if (s === 'partially_paid') return 'authorized';
  return FINANCIAL_STATUSES.has(s) ? (s as FinancialStatus) : 'pending';
}

// ---------------------------------------------------------------------------
// Normalised inputs — what lib/shopify-sync.ts writes
// ---------------------------------------------------------------------------

export interface CustomerInput {
  shopifyCustomerId: number | null;
  email: string | null;
  phoneE164: string | null;
  firstName: string | null;
  lastName: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  acceptsMarketing: boolean;
  /** Per-channel consent, when the payload says anything about it. */
  consents: { channel: 'whatsapp' | 'email' | 'sms'; status: 'opted_in' | 'opted_out' }[];
}

export interface OrderLineInput {
  shopifyProductId: number | null;
  variantId: number | null;
  title: string | null;
  qty: number;
  price: string;
}

export interface OrderInput {
  shopifyOrderId: number | null;
  orderNumber: string | null;
  total: string;
  subtotal: string | null;
  discountTotal: string;
  discountCodes: string[];
  currency: string;
  financialStatus: FinancialStatus;
  cancelledAt: Date | null;
  processedAt: Date;
  customer: CustomerInput;
  lines: OrderLineInput[];
}

export interface CheckoutInput {
  checkoutId: string;
  eventType: 'checkout_started' | 'checkout_updated';
  sessionId: string | null;
  occurredAt: Date;
  value: string | null;
  itemCount: number;
  customer: CustomerInput;
}

function marketingConsent(node: unknown): 'opted_in' | 'opted_out' | null {
  const c = obj(node);
  if (!c) return null;
  const state = str(c.state)?.toLowerCase();
  if (!state) return null;
  if (state === 'subscribed') return 'opted_in';
  if (state === 'unsubscribed' || state === 'redacted') return 'opted_out';
  // 'not_subscribed' and 'pending' are genuinely "unknown" — say nothing
  // rather than writing a consent row that claims more than Shopify does.
  return null;
}

/**
 * Build the customer identity from a customer payload, or from the `customer`
 * node (plus top-level `email`/`phone`) of an order or checkout payload.
 */
export function buildCustomerInput(
  customerNode: unknown,
  fallback: { email?: unknown; phone?: unknown; address?: unknown } = {},
): CustomerInput {
  const c = obj(customerNode) ?? {};
  const address = obj(c.default_address) ?? obj(fallback.address) ?? {};

  const phoneSources = [c.phone, fallback.phone, address.phone];
  let phoneE164: string | null = null;
  for (const source of phoneSources) {
    phoneE164 = normalizeE164(source);
    if (phoneE164) break;
  }

  const email = normalizeEmail(c.email) ?? normalizeEmail(fallback.email);

  const emailConsent = marketingConsent(c.email_marketing_consent);
  const smsConsent = marketingConsent(c.sms_marketing_consent);
  const consents: CustomerInput['consents'] = [];
  if (emailConsent) consents.push({ channel: 'email', status: emailConsent });
  if (smsConsent) {
    consents.push({ channel: 'sms', status: smsConsent });
    // WhatsApp consent is joined on the phone number (PRD-02 §F1.5). Shopify
    // has no WhatsApp channel, so SMS marketing consent — the only phone-based
    // consent it records — is what carries over.
    consents.push({ channel: 'whatsapp', status: smsConsent });
  }

  const acceptsMarketing =
    c.accepts_marketing === true || emailConsent === 'opted_in' || smsConsent === 'opted_in';

  return {
    shopifyCustomerId: toShopifyId(c.id),
    email,
    phoneE164,
    firstName: str(c.first_name),
    lastName: str(c.last_name),
    city: str(address.city),
    state: str(address.province),
    country: str(address.country_code) ?? str(address.country),
    acceptsMarketing,
    consents,
  };
}

export function buildOrderInput(payload: ShopifyPayload): OrderInput {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const discountCodes = Array.isArray(payload.discount_codes)
    ? payload.discount_codes
        .map((d) => str(obj(d)?.code) ?? str(d))
        .filter((c): c is string => c !== null)
    : [];

  // processed_at is NOT NULL in the schema. Shopify always sends one for real
  // orders; created_at is the documented fallback, and "now" is the last
  // resort so a payload missing both is still storable rather than lost.
  const processedAt =
    toTimestamp(payload.processed_at) ?? toTimestamp(payload.created_at) ?? new Date();

  const cancelledAt = toTimestamp(payload.cancelled_at);
  const financialStatus = mapFinancialStatus(payload.financial_status);

  return {
    shopifyOrderId: toShopifyId(payload.id),
    orderNumber: str(payload.name) ?? str(payload.order_number),
    total: toMoney(payload.total_price) ?? '0',
    subtotal: toMoney(payload.subtotal_price),
    discountTotal: toMoney(payload.total_discounts) ?? '0',
    discountCodes,
    currency: str(payload.currency) ?? 'INR',
    // A cancelled order keeps whatever financial state Shopify reports (often
    // `refunded` or `voided`); `cancelled` is used only when Shopify says the
    // order is cancelled and reports nothing more specific.
    financialStatus:
      cancelledAt && financialStatus === 'pending' ? 'cancelled' : financialStatus,
    cancelledAt,
    processedAt,
    customer: buildCustomerInput(payload.customer, {
      email: payload.email ?? payload.contact_email,
      phone: payload.phone,
      address: payload.shipping_address ?? payload.billing_address,
    }),
    lines: lineItems
      .map((raw): OrderLineInput | null => {
        const li = obj(raw);
        if (!li) return null;
        const qty = toShopifyId(li.quantity);
        return {
          shopifyProductId: toShopifyId(li.product_id),
          variantId: toShopifyId(li.variant_id),
          title: str(li.title),
          // order_items has CHECK (qty > 0), so a missing or nonsense quantity
          // becomes 1 rather than a row Postgres will reject.
          qty: qty !== null && qty > 0 ? qty : 1,
          price: toMoney(li.price) ?? '0',
        };
      })
      .filter((l): l is OrderLineInput => l !== null),
  };
}

export function buildCheckoutInput(
  topic: 'checkouts/create' | 'checkouts/update',
  payload: ShopifyPayload,
): CheckoutInput | null {
  const checkoutId = extractShopifyId(payload);
  if (!checkoutId) return null;

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];
  const occurredAt =
    toTimestamp(topic === 'checkouts/create' ? payload.created_at : payload.updated_at) ??
    toTimestamp(payload.created_at) ??
    new Date();

  return {
    checkoutId,
    eventType: topic === 'checkouts/create' ? 'checkout_started' : 'checkout_updated',
    sessionId: str(payload.cart_token) ?? str(payload.token),
    occurredAt,
    value: toMoney(payload.total_price),
    itemCount: lineItems.length,
    customer: buildCustomerInput(payload.customer, {
      email: payload.email,
      phone: payload.phone,
      address: payload.shipping_address ?? payload.billing_address,
    }),
  };
}
