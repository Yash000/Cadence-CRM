// Pure request validation for POST /api/inbox/simulate — split from the route
// (and from db/index) so it is unit-testable without DATABASE_URL, the same
// pattern as lib/events.ts.

export const SIM_CHANNELS = ['whatsapp', 'email', 'sms'] as const;
export type SimChannel = (typeof SIM_CHANNELS)[number];

export const MAX_BODY_LENGTH = 4000;

export interface SimulateInput {
  channel: SimChannel;
  body: string;
  phone: string | null;
  email: string | null;
  customerId: string | null;
  autoDraft: boolean;
}

export type ParseResult =
  | { ok: true; value: SimulateInput }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSimulateInput(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;

  const channel = o.channel === undefined ? 'whatsapp' : o.channel;
  if (typeof channel !== 'string' || !SIM_CHANNELS.includes(channel as SimChannel)) {
    return { ok: false, error: `channel must be one of ${SIM_CHANNELS.join(', ')}` };
  }

  if (typeof o.body !== 'string' || o.body.trim() === '') {
    return { ok: false, error: 'body is required and must be a non-empty string' };
  }
  if (o.body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
  }

  const phone = typeof o.phone === 'string' && o.phone.trim() !== '' ? o.phone.trim() : null;
  const email = typeof o.email === 'string' && o.email.trim() !== '' ? o.email.trim() : null;
  const customerId =
    typeof o.customer_id === 'string' && o.customer_id.trim() !== ''
      ? o.customer_id.trim()
      : typeof o.customerId === 'string' && o.customerId.trim() !== ''
        ? o.customerId.trim()
        : null;
  if (customerId && !UUID_RE.test(customerId)) {
    return { ok: false, error: 'customer_id must be a UUID' };
  }

  if (channel === 'email' && !customerId && !email) {
    return { ok: false, error: 'email inbound needs an email address or a customer_id' };
  }
  if (channel !== 'email' && !customerId && !phone) {
    return { ok: false, error: 'whatsapp/sms inbound needs a phone or a customer_id' };
  }

  const autoDraft = o.auto_draft === true || o.autoDraft === true;

  return {
    ok: true,
    value: { channel: channel as SimChannel, body: o.body, phone, email, customerId, autoDraft },
  };
}
