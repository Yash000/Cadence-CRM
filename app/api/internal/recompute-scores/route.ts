// POST /api/internal/recompute-scores — full 801-customer rescore, for n8n.
//
// WHY THIS EXISTS. The scoring job is db/scoring.sql, run by
// scripts/recompute-scores.mjs from a developer's machine. Nothing scheduled
// it, so scores silently aged (they were 11 days stale when this was written).
// n8n workflow 02 ran nightly but only READ v_customer_scores to check
// coverage — it had no way to trigger the recompute, because its Postgres
// credential is the read-only cadence_agent role and the scoring SQL writes.
// This endpoint is the missing link: n8n calls it, the app runs the same SQL
// the batch script runs, and there is still exactly one definition of what a
// score means (see lib/scoring.ts).
//
// WHY A REQUEST HANDLER IS OK HERE, despite the caution in
// app/api/customers/[id]/recompute/route.ts that a full rescore "is a batch
// job, not something a request handler should hold a connection open for":
// that was written without a measurement. Measured, a full run over 801
// customers is ~1s, because db/scoring.sql is ONE set-based statement, not a
// per-customer loop. The per-customer route stays scoped to one customer
// because that is what its UI button means, not because the full run is slow.
// If the customer base grows by an order of magnitude, re-measure and move
// this back to a queue.
//
// AUTH. Unlike the per-customer route (which is same-origin from the app's own
// UI and leans on a per-IP rate limit), this is called by an external system,
// writes every score row, and is not behind any session. It requires a shared
// secret in x-cadence-trigger-secret, compared with timingSafeEqual. With
// SCORING_TRIGGER_SECRET unset the route refuses every request rather than
// running unauthenticated — a misconfiguration must not silently open it.
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { recomputeScores } from '../../../../lib/scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Measured ~1s; 60s leaves room for a cold start plus a slow pooler handshake.
export const maxDuration = 60;

/** Constant-time compare that does not leak the secret's length via early return. */
function secretMatches(sent: string | null, expected: string): boolean {
  if (!sent) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.SCORING_TRIGGER_SECRET;
  if (!expected) {
    console.error('[recompute-all] SCORING_TRIGGER_SECRET is not set — refusing.');
    return NextResponse.json(
      { ok: false, error: 'Scoring trigger is not configured on this deployment.' },
      { status: 503 },
    );
  }

  if (!secretMatches(request.headers.get('x-cadence-trigger-secret'), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await recomputeScores(null);
    console.log(`[recompute-all] scored ${result.scored} customers in ${result.elapsedMs}ms`);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // The message is logged, not returned: it can name the database host.
    console.error('[recompute-all] failed', err);
    return NextResponse.json({ ok: false, error: 'Recompute failed.' }, { status: 500 });
  }
}

// Scoring writes. A GET that rescored 801 customers would fire on any prefetch,
// crawler or browser address-bar visit.
export function GET(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'this endpoint accepts POST only' },
    { status: 405 },
  );
}
