// Routes an Ask Cadence question through n8n's own copy of the agent
// (n8n-space/workflows/04-ask-cadence-agent.json) instead of running it
// in-process via ask.ts. Exists for one reason: so a question typed into the
// real app shows up as a live execution in n8n's UI, for demoing the
// workflow. It is NOT the production path — ask() in ./ask.ts stays the
// default; this only runs when AGENT_VIA_N8N_WEBHOOK is set, see route.ts.
//
// Same model, same system prompt (n8n's copy was extracted verbatim from
// agentSystemPrompt(), see the build note in the workflow JSON), same
// cadence_agent read-only database role. What's genuinely different:
//
//   - No conversation memory. Workflow 04 has no Memory node wired up, so
//     `history` is accepted here for interface parity with ask() but ignored.
//     Every question is answered cold. A follow-up like "just the ones in
//     Mumbai" will not work over this path.
//   - No sql-guard.ts. The database role is the only boundary (see the
//     Postgres Tool node's own notes in the workflow). A query outside the
//     five views comes back as a raw Postgres error inside the tool
//     observation rather than the guard's friendlier rejection text.
//   - No real token/cost accounting. n8n's chat webhook response does not
//     include token usage, so promptTokens/completionTokens are reported as
//     0 and costUsd as null here -- honestly absent, not guessed. (It is
//     recoverable from n8n's own execution log via a second, authenticated
//     API call, which this deliberately does not do, to keep this a single
//     round trip.)
import { logAiCall } from './log';
import { AGENT_MODEL_ID } from './model';
import type { AskHistoryTurn, AskQueryLog, AskResult } from './ask';

interface N8nToolAction {
  tool: string;
  toolInput: { sql?: string };
}

interface N8nIntermediateStep {
  action: N8nToolAction;
  observation: string;
}

interface N8nChatResponse {
  output: string;
  intermediateSteps?: N8nIntermediateStep[];
}

function parseObservation(observation: string): Record<string, unknown>[] | null {
  try {
    const parsed = JSON.parse(observation);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null; // not JSON -- this step's observation is an error/rejection string
  }
}

export async function askViaN8n(
  question: string,
  _history: AskHistoryTurn[] = [],
): Promise<AskResult> {
  const webhookUrl = process.env.AGENT_VIA_N8N_WEBHOOK;
  if (!webhookUrl) {
    throw new Error('AGENT_VIA_N8N_WEBHOOK is not set.');
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatInput: question,
        sessionId: crypto.randomUUID(),
        action: 'sendMessage',
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'n8n webhook unreachable';
    await logAiCall({
      feature: 'agent.sql',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs: Date.now() - startedAt,
      outcome: 'error',
      error: message,
    });
    return {
      question,
      answer: 'Ask Cadence (via n8n) could not be reached. Is the n8n container running?',
      sql: null,
      queries: [],
      columns: [],
      rows: [],
      rowCount: 0,
      outcome: 'error',
      error: message,
      usage: { model: AGENT_MODEL_ID, promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs: Date.now() - startedAt },
    };
  }

  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const message = bodyText || `n8n webhook returned ${res.status}`;
    await logAiCall({
      feature: 'agent.sql',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs,
      outcome: 'error',
      error: message,
    });
    return {
      question,
      answer: 'Ask Cadence (via n8n) hit an error. Check the execution log in n8n for the real cause.',
      sql: null,
      queries: [],
      columns: [],
      rows: [],
      rowCount: 0,
      outcome: 'error',
      error: message,
      usage: { model: AGENT_MODEL_ID, promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs },
    };
  }

  const body = (await res.json()) as N8nChatResponse;
  const steps = body.intermediateSteps ?? [];
  const usage = { model: AGENT_MODEL_ID, promptTokens: 0, completionTokens: 0, costUsd: null, latencyMs };

  // Same rule ask.ts uses: zero tool calls means the model decided the
  // question didn't need one (methodology question, or a genuine refusal) --
  // both are reported as 'refused', matching the real app exactly.
  if (steps.length === 0) {
    await logAiCall({
      feature: 'agent.sql',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs,
      outcome: 'refused',
      error: body.output || null,
    });
    return {
      question,
      answer: body.output || 'That question cannot be answered from this data.',
      sql: null,
      queries: [],
      columns: [],
      rows: [],
      rowCount: 0,
      outcome: 'refused',
      error: null,
      usage,
    };
  }

  const queries: AskQueryLog[] = [];
  let lastSuccess: { sql: string; rows: Record<string, unknown>[] } | null = null;
  let lastError: string | null = null;

  for (const step of steps) {
    const sql = step.action?.toolInput?.sql ?? '(no SQL captured)';
    const rows = parseObservation(step.observation);
    if (rows) {
      queries.push({ sql, rowCount: rows.length, error: null });
      lastSuccess = { sql, rows };
    } else {
      queries.push({ sql, rowCount: null, error: step.observation });
      lastError = step.observation;
    }
  }

  if (!lastSuccess) {
    // Every run_sql attempt this turn was rejected -- same as ask.ts's
    // "self-correction ran out of turns" branch.
    await logAiCall({
      feature: 'agent.sql',
      model: AGENT_MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      latencyMs,
      outcome: 'error',
      generatedSql: queries.at(-1)?.sql ?? null,
      error: lastError,
    });
    return {
      question,
      answer: body.output || `That query was rejected: ${lastError}`,
      sql: null,
      queries,
      columns: [],
      rows: [],
      rowCount: 0,
      outcome: 'error',
      error: lastError,
      usage,
    };
  }

  const columns = lastSuccess.rows.length > 0 ? Object.keys(lastSuccess.rows[0]) : [];
  await logAiCall({
    feature: 'agent.sql',
    model: AGENT_MODEL_ID,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    latencyMs,
    outcome: 'success',
    generatedSql: lastSuccess.sql,
  });

  return {
    question,
    answer: body.output || `${lastSuccess.rows.length} row${lastSuccess.rows.length === 1 ? '' : 's'} returned.`,
    sql: lastSuccess.sql,
    queries,
    columns,
    rows: lastSuccess.rows,
    rowCount: lastSuccess.rows.length,
    outcome: 'success',
    error: null,
    usage,
  };
}
