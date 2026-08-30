// POST /api/customers/[id]/recompute — PRD-02 §F3.7's "recompute now".
//
// This exists for the §11 demo: an order lands by webhook, someone presses
// Rescore on that customer's 360, and the segment and churn score change on
// screen. Scoped to ONE customer on purpose — a full 800-customer rescore is
// a batch job (scripts/recompute-scores.mjs), not something a request handler
// should hold a connection open for.
import { NextResponse } from 'next/server';
import { isUuid } from '../../../../../lib/list-params';
import { recomputeScores } from '../../../../../lib/scoring';
import { checkRateLimit, clientKey } from '../../../../../lib/agent/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Writes, and holds an app pool connection while the scoring SQL runs. Auth is
// deferred to §F9; until then the same per-IP floor the agent route uses is
// what stops this being an unmetered way to keep the database busy.
const RECOMPUTE_RATE_LIMIT = 20;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const limit = checkRateLimit(
    `recompute:${clientKey(request)}`,
    Date.now(),
    RECOMPUTE_RATE_LIMIT,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: 'Rate limit reached. Try again shortly.' },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ ok: false, error: 'Not a customer id.' }, { status: 400 });
  }

  try {
    const result = await recomputeScores(id);
    // 0 rows means the uuid is well-formed but matches no customer — or one
    // with no orders to score. Either way the caller asked to rescore
    // something that does not exist, which is a 404, not a silent success.
    if (result.scored === 0) {
      return NextResponse.json(
        { ok: false, error: 'No customer to score for that id.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[recompute] failed for', id, err);
    return NextResponse.json({ ok: false, error: 'Recompute failed.' }, { status: 500 });
  }
}
