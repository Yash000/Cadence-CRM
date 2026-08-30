// Storefront event tracking endpoint — PRD-01 §7.
//
// Two callers: the Dawn theme's tracking snippet
// (rasaya-theme/snippets/cadence-tracking.liquid, assets/cadence-tracking.js),
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
// for one. The allow-listed `type` values (lib/events.ts) and the payload
// size cap are the only defenses against a hostile POST; this is a
// best-effort analytics sink, not a source of truth the CRM's money or
// customer-identity logic depends on.
import { NextResponse } from 'next/server';
import { parseEventInput } from '../../../lib/events';
import { getRecentEvents, insertEvent } from '../../../lib/events-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIMULATOR_HEADER = 'x-cadence-source';

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'request body is not valid JSON' },
      { status: 400 },
    );
  }

  // The source is decided by which header the CALLER sends, never trusted
  // from the body — see parseEventInput's doc comment. Only the simulator UI
  // (components/simulator/simulator-form.tsx) ever sends this header.
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
