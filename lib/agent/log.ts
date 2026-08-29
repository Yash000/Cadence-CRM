// ai_logs writer (PRD-02 §F4.9).
//
// WHAT IS DELIBERATELY NOT STORED: the prompt, the user's question and the
// returned rows. The prompt for the answering call contains real customer rows
// — names, cities, order values — and ai_logs is a long-lived operational
// table read by anyone with app access. Storing the prompt would quietly turn
// an observability table into a second, unmanaged copy of customer data with
// no retention policy behind it. §F4.9 asks for feature, model, tokens, cost,
// latency, outcome and the generated SQL; that is exactly what goes in, and
// the SQL is the part that actually makes a call reproducible.
//
// Writes go through the app's own DATABASE_URL connection: cadence_agent
// cannot see ai_logs at all (verify-agent-role.mjs asserts that), which is the
// point — the agent cannot read or rewrite its own audit trail.
import { db, schema } from '../../db/index';

export type AgentFeature = 'agent.sql' | 'agent.answer';

export interface AiLogEntry {
  feature: AgentFeature;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Actual OpenRouter credit cost in USD, or null when it was not reported. */
  costUsd: number | null;
  latencyMs: number;
  outcome: 'success' | 'refused' | 'error';
  generatedSql?: string | null;
  error?: string | null;
}

export async function logAiCall(entry: AiLogEntry): Promise<void> {
  try {
    await db.insert(schema.aiLogs).values({
      feature: entry.feature,
      model: entry.model,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      // numeric(12,6): pass a string so the value reaches Postgres exactly as
      // reported, without a float round-trip.
      costUsd: entry.costUsd == null ? '0' : entry.costUsd.toFixed(6),
      latencyMs: entry.latencyMs,
      outcome: entry.outcome,
      generatedSql: entry.generatedSql ?? null,
      error: entry.error ? entry.error.slice(0, 2000) : null,
    });
  } catch (err) {
    // Logging must never take down an answer the user already has. Surface it
    // on the server console instead of throwing into the request path.
    console.error('[agent] failed to write ai_logs row:', err);
  }
}
