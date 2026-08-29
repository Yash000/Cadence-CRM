// Vercel AI SDK -> OpenRouter, model openai/gpt-5-mini (PRD-02 §F4, §9).
//
// No LangChain: PRD-02 §9 is explicit about that, and there is nothing here an
// orchestration framework would add — two model calls and a Zod parse.
//
// Usage accounting is switched on so OpenRouter returns the ACTUAL credit cost
// of each generation in providerMetadata; ai_logs.cost_usd is that number, not
// an estimate from a hardcoded price table.
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

export const AGENT_MODEL_ID = 'openai/gpt-5-mini';

let provider: ReturnType<typeof createOpenRouter> | null = null;

export function agentModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set in .env.local.');
  }
  provider ??= createOpenRouter({ apiKey });
  return provider(AGENT_MODEL_ID, { usage: { include: true } });
}

/**
 * The real cost of one generation, in USD, as reported by OpenRouter's usage
 * accounting. Returns null rather than guessing when the field is absent — a
 * fabricated cost in ai_logs is worse than a null one.
 */
export function openRouterCostUsd(
  providerMetadata: Record<string, unknown> | undefined,
): number | null {
  const openrouter = providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined;
  const cost = openrouter?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}
