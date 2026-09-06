// Tests for the agent's system prompt (PRD-02 §F4.8).
//
// The one that matters is the scoring fingerprint at the bottom. Here is why
// it exists.
//
// The four views the agent may read expose only the OUTPUTS of the nightly
// scoring job — churn_risk, predicted_ltv, segment, next_order_date. The
// formulas that produce them live in db/scoring.sql, which the agent cannot
// read and which no query can reach. Asked "what's the formula you used to
// decide this churn", the agent therefore had no grounded source, and it did
// the worst available thing: it ran a query, then invented a plausible answer
// ("computed from RFM ... with further adjustments for order_count and
// lifetime_value"). None of that is true — churn_risk is a piecewise curve on
// the overdue ratio alone. For a product whose claim is that every number sits
// next to the reason it was computed, a confident wrong formula is a worse
// failure than a refusal.
//
// The fix was to transcribe the real formulas into SCORING_METHODOLOGY in
// lib/agent/prompt.ts. That buys correctness at the cost of a duplication: the
// prompt now restates db/scoring.sql, and a stale-but-confident formula is
// worse than none at all.
//
// A fifth read-only view exposing the definitions was considered and rejected.
// Unless it were GENERATED from scoring.sql it would still be a hand-maintained
// transcription — the staleness risk moves from a TypeScript file to a SQL
// file, and it costs a schema change plus a grant to the agent role. The
// standing rule in lib/agent/sql-guard.ts is "never add a grant to compensate";
// widening the role to solve a documentation problem is the wrong trade.
//
// So the duplication stays, and this test makes it LOUD instead of silent.
// It cannot verify that the prose is correct — only a human reading both can
// do that. What it guarantees is that nobody changes the scoring without being
// told to go and look.
//
// KNOWN BLIND SPOT, and it has already drawn blood. The fingerprint detects
// scoring.sql DRIFTING AWAY from the prose. It cannot detect prose that never
// covered part of scoring.sql in the first place, because on day one the hash
// matches by construction no matter how incomplete the block is. That is not a
// hypothetical: the first version of SCORING_METHODOLOGY described `segment`
// as "the RFM grid plus a cadence override" and silently omitted the pre-grid
// short-circuits, so the agent told a user that `new_customer` was an RFM cell
// — which scoring.sql denies in as many words. Every formula the block stated
// was accurate; a reviewer checked them line by line and called it verified.
// Accuracy of what is written is not coverage of what is there.
//
// The assertions above are the partial answer: they pin specific load-bearing
// claims so that block cannot quietly lose them. They do not prove
// completeness either, and nothing cheap does. When scoring.sql grows a new
// branch, read it for what the prompt DOES NOT SAY, not just for what it now
// says wrongly.
//
// The hash covers the WHOLE file rather than the scoring CTEs alone. That is
// deliberate: a line-range hash silently stops covering the right lines the
// moment anything above it shifts, and the failure modes are not symmetric. A
// false alarm costs someone two minutes to re-read a block and update a
// constant; a miss ships an agent that states a wrong formula with confidence.
// Prefer the noisy option.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { agentSystemPrompt } from '../lib/agent/prompt';

const SCORING_SQL_PATH = new URL('../db/scoring.sql', import.meta.url);

/**
 * sha256 of db/scoring.sql with line endings normalised to \n, so the test
 * gives the same answer on a CRLF checkout as on an LF one.
 *
 * TO UPDATE: re-read SCORING_METHODOLOGY in lib/agent/prompt.ts against
 * db/scoring.sql, correct it if the formulas moved, and only then paste the
 * new hash the failure message prints. Updating this constant without doing
 * that re-read defeats the entire point of the test.
 *
 * This value currently covers an UNCOMMITTED working-tree change to
 * db/scoring.sql (next_order_date is no longer clamped forward to today; it is
 * the raw forecast, so a date in the past now means the customer is overdue
 * rather than that the scores are stale — SCORING_METHODOLOGY says so). If
 * that change is reverted or amended before it lands, this test fires again,
 * which is the correct behaviour and not a fault.
 */
const SCORING_SQL_SHA256 = '869bdaa4af83d01540e15af39d8261cf75fe6098c376d9abe8ca3c8545397a13';

function scoringSqlHash(): string {
  const raw = readFileSync(SCORING_SQL_PATH, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(raw).digest('hex');
}

describe('agent system prompt', () => {
  it('documents the scoring formulas the views cannot expose', () => {
    const prompt = agentSystemPrompt('2026-08-30', 4);

    // The churn curve's knots — the specific numbers the agent previously
    // guessed at. Each appears verbatim in db/scoring.sql.
    assert.match(prompt, /overdue \* 20/);
    assert.match(prompt, /20 \+ \(overdue - 1\) \* 40/);
    assert.match(prompt, /60 \+ \(overdue - 2\) \* 30/);
    assert.match(prompt, /90 \+ min\(10, \(overdue - 3\) \* 5\)/);

    // The literals inlined from the params CTE.
    assert.match(prompt, /0\.45/); // margin
    assert.match(prompt, /365/); // horizon_days
    assert.match(prompt, /min\(12,/); // max_future_orders
    assert.match(prompt, /0\.05/); // survival floor

    // The negative claim is the one that was actually wrong, so assert it is
    // stated rather than merely implied.
    assert.match(prompt, /NOT inputs to churn_risk/);
  });

  it('states the pre-grid segment branches, not just the RFM grid', () => {
    const prompt = agentSystemPrompt('2026-08-30', 4);

    // The omission that made the agent call new_customer an RFM cell. The
    // grid is only the middle of three layers and the prompt has to say so,
    // because scoring.sql:286 says "new_customer is not a grid cell" and the
    // agent was contradicting it.
    assert.match(prompt, /NOT grid cells/);
    assert.match(prompt, /order_count = 1 and days_since <= 90/);
    assert.match(prompt, /days_since_signup <= 90/);

    // The cadence override — the branch the product's whole thesis rests on.
    assert.match(prompt, /overdue >= 4 and days_since >= 270/);
    assert.match(prompt, /churn_risk >= 65/);
    assert.match(prompt, /churn_risk <= 35/);
  });

  it('tells the model to answer methodology questions without a query', () => {
    const prompt = agentSystemPrompt('2026-08-30', 4);
    assert.match(prompt, /METHODOLOGY/);
    assert.match(prompt, /do NOT call run_sql/);
  });

  it('passes the caller-supplied date and tool budget through', () => {
    const prompt = agentSystemPrompt('2026-01-15', 3);
    assert.match(prompt, /Today is 2026-01-15/);
    assert.match(prompt, /at most 3 calls/);
  });

  // ---------------------------------------------------------------------
  // The staleness alarm.
  // ---------------------------------------------------------------------
  it('fails when db/scoring.sql changes, so the prompt gets re-verified', () => {
    const actual = scoringSqlHash();
    assert.equal(
      actual,
      SCORING_SQL_SHA256,
      '\n\n' +
        'db/scoring.sql has changed since SCORING_METHODOLOGY was last verified.\n\n' +
        'The agent quotes those formulas to users as authoritative, and they are\n' +
        'not retrievable by any query — a stale one is stated with full confidence\n' +
        'and nothing contradicts it.\n\n' +
        'Re-read SCORING_METHODOLOGY in lib/agent/prompt.ts against db/scoring.sql,\n' +
        'update the prose if the formulas moved, THEN set SCORING_SQL_SHA256 in\n' +
        'tests/agent-prompt.test.ts to:\n\n' +
        `  ${actual}\n`,
    );
  });
});
