// POST /api/agent — the Ask Cadence endpoint (PRD-02 §F4).
//
// The whole loop runs server-side: the OpenRouter key, AGENT_DATABASE_URL and
// the generated SQL never leave this process except as the fields below. The
// response deliberately includes the executed SQL — §F4.5 requires it to be
// shown next to every answer, because an answer whose query you cannot read is
// not an answer you can act on.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ask, MAX_HISTORY_TURNS, MAX_QUESTION_LENGTH } from '../../../lib/agent/ask';
import { checkRateLimit, clientKey, RATE_LIMIT } from '../../../lib/agent/rate-limit';

// Node runtime: the agent uses the `pg` driver. Never cached — every question
// is a live query, and the underlying data changes with every webhook.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `history` is the client's own transcript, not a server-side session: this
// endpoint stores nothing between requests (see lib/agent/ask.ts). The client
// may hold more turns than this; only the tail up to MAX_HISTORY_TURNS is ever
// used, so a long conversation cannot grow the prompt sent to the model.
const RequestSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION_LENGTH),
  history: z
    .array(
      z.object({
        question: z.string().min(1).max(MAX_QUESTION_LENGTH),
        answer: z.string().min(1),
      }),
    )
    .max(MAX_HISTORY_TURNS)
    .optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // Rate limit before anything else: the point is to spend neither an
  // OpenRouter call nor an agent pool connection on a caller who is over the
  // line. See lib/agent/rate-limit.ts for what this does and does not cover.
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Rate limit reached (${RATE_LIMIT} questions per minute). Try again shortly.` },
      { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Send { "question": string } with 1-${MAX_QUESTION_LENGTH} characters.` },
      { status: 400 },
    );
  }

  try {
    const result = await ask(parsed.data.question, parsed.data.history ?? []);
    return NextResponse.json(result);
  } catch (err) {
    // A misconfiguration (missing OPENROUTER_API_KEY, missing
    // AGENT_DATABASE_URL) lands here. The message is safe to show: it names
    // the variable, never its value.
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[agent] request failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
