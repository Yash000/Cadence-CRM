// Routes Inbox reply drafting through n8n's own copy of the drafting logic
// (n8n-space/workflows/05-inbox-reply-draft.json) instead of running it
// in-process via inbox-draft.ts. Same reason ask-via-n8n.ts exists: so a
// message landed through the real Inbox shows up as a live execution in n8n,
// for demoing the workflow. NOT the production path -- generateReplyDraft()
// in ./inbox-draft stays the default; this only runs when
// INBOX_DRAFT_VIA_N8N_WEBHOOK is set, see app/api/inbox/simulate/route.ts.
//
// This is a genuinely different SHAPE from ask-via-n8n.ts, not just a copy of
// it: the real generateReplyDraft() is one generateObject() call -- no tool
// loop, no run_sql, no agent. So workflow 05 uses n8n's Basic LLM Chain +
// Structured Output Parser, not the AI Agent node. The order-history context
// (recentOrderContext, exported from ./inbox-draft) is still computed here in
// Next.js and passed to n8n as a plain field -- the workflow does not query
// Postgres itself, matching how generateReplyDraft builds its own prompt.
//
// What's genuinely different from the in-process path:
//   - No real token/cost accounting. n8n's webhook response does not include
//     usage, so promptTokens/completionTokens are 0 and costUsd is null here,
//     same honest-absence convention as ask-via-n8n.ts.
//   - One fewer safety net: generateReplyDraft() falls back to a canned reply
//     when OPENROUTER_API_KEY is unset; this path instead falls back when the
//     n8n webhook itself is unreachable or errors, which is a different
//     failure mode (n8n down vs. no API key) but the same DraftResult shape.
import { recentOrderContext } from './inbox-draft';
import { fallbackDraft } from './inbox-db';
import { logAiCall } from './agent/log';
import { AGENT_MODEL_ID } from './agent/model';
import type { DraftContext, DraftResult, IntentTag } from './inbox-draft';

const INTENT_TAGS = ['order_status', 'return_request', 'product_question', 'complaint'] as const;

interface N8nDraftResponse {
  output?: { intent?: string; reply?: string };
}

function isIntentTag(value: unknown): value is IntentTag {
  return typeof value === 'string' && (INTENT_TAGS as readonly string[]).includes(value);
}

export async function generateReplyDraftViaN8n(ctx: DraftContext): Promise<DraftResult> {
  const webhookUrl = process.env.INBOX_DRAFT_VIA_N8N_WEBHOOK;
  const fallback: DraftResult = {
    reply: fallbackDraft(ctx.customerName, ctx.channel),
    intent: null,
    aiGenerated: false,
  };

  if (!webhookUrl) {
    throw new Error('INBOX_DRAFT_VIA_N8N_WEBHOOK is not set.');
  }

  let orderContext = '';
  try {
    orderContext = await recentOrderContext(ctx.customerId);
  } catch {
    orderContext = 'Order context unavailable.';
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: ctx.channel,
        customerName: ctx.customerName ?? 'unknown',
        orderContext,
        inboundBody: ctx.inboundBody.slice(0, 2000),
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'n8n webhook unreachable';
    await logAiCall({
      feature: 'inbox.draft',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - startedAt,
      outcome: 'error',
      error: message,
    });
    return fallback;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    await logAiCall({
      feature: 'inbox.draft',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - startedAt,
      outcome: 'error',
      error: bodyText || `n8n webhook returned ${res.status}`,
    });
    return fallback;
  }

  const body = (await res.json()) as N8nDraftResponse;
  const reply = body.output?.reply?.trim();
  const intent = isIntentTag(body.output?.intent) ? body.output.intent : null;

  if (!reply) {
    await logAiCall({
      feature: 'inbox.draft',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - startedAt,
      outcome: 'error',
      error: 'n8n response had no reply field',
    });
    return fallback;
  }

  await logAiCall({
    feature: 'inbox.draft',
    model: AGENT_MODEL_ID,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    latencyMs: Date.now() - startedAt,
    outcome: 'success',
  });

  return { reply, intent, aiGenerated: true };
}
