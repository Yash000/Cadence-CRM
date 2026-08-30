// Runs db/scoring.sql from inside the app (PRD-02 §F3.7 — "recompute now").
//
// scripts/recompute-scores.mjs is the batch runner and the evidence report;
// this is the same SQL invoked for a single customer from a request handler.
// Both execute the identical file, so there is exactly one definition of what
// a score means — a second, hand-copied "quick scoring" query for the live
// path is how the demo and the batch job start disagreeing on screen.
//
// db/scoring.sql takes $1 as its customer filter: a uuid scopes the run to one
// customer, null rescores everyone. Passed as a bound parameter, never
// interpolated. Uses db.$client (the pg Pool) directly rather than Drizzle's
// tagged template, because the file is a whole prepared statement already.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../db/index';

// Read once per process. The file ships in the repo, not in .next, so this
// resolves against the working directory the server was started from — the
// project root for both `next dev` and `next start`.
let cached: string | null = null;

function scoringSql(): string {
  cached ??= readFileSync(join(process.cwd(), 'db', 'scoring.sql'), 'utf8');
  return cached;
}

export interface RecomputeResult {
  /** How many customer_scores rows the run wrote. */
  scored: number;
  elapsedMs: number;
}

/**
 * Recompute scores. Pass a customer uuid to scope the run to one customer, or
 * null to rescore every customer.
 *
 * Scoring reads now(), not a frozen anchor — see the TIME note in
 * scripts/recompute-scores.mjs. Two runs minutes apart produce identical
 * scores, so this is safe to invoke repeatedly from a button.
 */
export async function recomputeScores(customerId: string | null): Promise<RecomputeResult> {
  const startedAt = Date.now();
  const result = await db.$client.query(scoringSql(), [customerId]);
  return { scored: result.rowCount ?? 0, elapsedMs: Date.now() - startedAt };
}
