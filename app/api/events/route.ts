// Storefront event tracking endpoint — PRD-01 §7.
//
// Two callers: the Dawn theme's tracking snippet
// (homestyle-theme/snippets/cadence-tracking.liquid, assets/cadence-tracking.js),
// reachable from the open internet with no auth once the theme is live and a
// public URL is configured in theme settings; and the in-app event simulator
// (app/simulator), same-origin from inside this app. Both post the identical
// JSON shape — see lib/events.ts for the schema both share.
//
// LIVE DELIVERY FROM THE REAL STOREFRONT IS UNTESTED. This dev environment
// has no public URL for the theme to reach: the Cloudflare tunnel that would
// provide one fails under WARP, and `shopify app dev --use-localhost` (the
// working alternative) explicitly cannot receive inbound traffic. The
// simulator exists precisely so the endpoint, and everything downstream of
// it, can be exercised without a public URL — see task-9-report.md.
//
// No HMAC here, unlike /api/webhooks/shopify — this is not a Shopify webhook,
// there is no shared secret to verify it against, and PRD-01 §7 does not ask
// for one. A tracking pixel that runs in the visitor's browser has no secret
// it could keep. So this endpoint is UNAUTHENTICATED BY DESIGN, and the only
// defenses against a hostile POST are the allow-listed `type` values and
// payload cap in lib/events.ts, plus the per-IP rate limit below. This is a
// best-effort analytics sink, not a source of truth the CRM's money or
// customer-identity logic depends on.
import { NextResponse } from 'next/server';
import { parseEventInput } from '../../../lib/events';
import { getRecentEvents, insertEvent } from '../../../lib/events-db';
import { checkRateLimit, clientKey, EVENTS_RATE_LIMIT } from '../../../lib/agent/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIMULATOR_HEADER = 'x-cadence-source';

export async function POST(request: Request): Promise<NextResponse> {
  // Before parsing or writing: this is an unauthenticated public write into
  // `events`, so the rate limit is the only thing bounding how fast a single
  // address can grow that table. Namespaced key — /api/agent has its own,
  // much smaller budget out of the same window map.
  const limit = checkRateLimit(`events:${clientKey(request)}`, Date.now(), EVENTS_RATE_LIMIT);
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
    return NextResponse.json(
      { ok: false, error: 'request body is not valid JSON' },
      { status: 400 },
    );
  }

  // `source` is taken from a header rather than the body only so that a body
  // field cannot set it by accident. It is NOT a trust boundary: the header is
  // caller-supplied on an unauthenticated endpoint, so anyone can send either
  // value and label their own writes 'simulator' or 'storefront_pixel' at
  // will. Treat events.source as a hint about which UI produced a row in
  // normal operation, never as evidence of origin.
  const source =
    request.headers.get(SIMULATOR_HEADER) === 'simulator' ? 'simulator' : 'storefront_pixel';

  const parsed = parseEventInput(body, source);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  try {
    const inserted = await insertEvent(parsed.value);
    return NextResponse.json(
      { ok: true, id: inserted.id, customerId: inserted.customerId },
      { status: 201 },
    );
  } catch (err) {
    console.error('[events] failed to insert event', err);
    return NextResponse.json({ ok: false, error: 'failed to record event' }, { status: 500 });
  }
}

// Not part of PRD-01 §7's tracking contract — a small read-back so the
// simulator page (and a human hitting this URL directly) can see that
// deliveries are actually landing in `events`.
export async function GET(request: Request): Promise<NextResponse> {
  const limitParam = new URL(request.url).searchParams.get('limit');
  const limit = Math.min(Math.max(Number(limitParam) || 20, 1), 100);
  try {
    const recent = await getRecentEvents(limit);
    return NextResponse.json({ ok: true, events: recent });
  } catch (err) {
    console.error('[events] failed to list recent events', err);
    return NextResponse.json({ ok: false, error: 'failed to list events' }, { status: 500 });
  }
}
