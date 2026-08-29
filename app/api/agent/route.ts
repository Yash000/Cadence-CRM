// POST /api/agent — the Ask Cadence endpoint (PRD-02 §F4).
//
// The whole loop runs server-side: the OpenRouter key, AGENT_DATABASE_URL and
// the generated SQL never leave this process except as the fields below. The
// response deliberately includes the executed SQL — §F4.5 requires it to be
// shown next to every answer, because an answer whose query you cannot read is
// not an answer you can act on.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ask, MAX_QUESTION_LENGTH } from '../../../lib/agent/ask';

// Node runtime: the agent uses the `pg` driver. Never cached — every question
// is a live query, and the underlying data changes with every webhook.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  question: z.string().min(1).max(MAX_QUESTION_LENGTH),
});

export async function POST(request: Request): Promise<NextResponse> {
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
    const result = await ask(parsed.data.question);
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
