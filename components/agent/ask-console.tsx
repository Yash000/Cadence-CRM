'use client';

// Ask Cadence — a chat interface over the customer dataset (PRD-02 §F4.5, §F4.6).
//
// Two panes: the conversation on the left, and an inspector on the right that
// shows the SQL and the result table for whichever turn you have selected.
// §F4.5 requires the query to sit next to the answer — a side panel satisfies
// that better than an inline disclosure, because a 12-column result table
// needs the width and the conversation needs to stay readable. The panel opens
// on its own when an answer arrives and can be dismissed.
//
// Each turn is one request/response round-trip to POST /api/agent: the server
// is not a streaming chat endpoint, it returns one finished answer (validation
// is server-side in lib/agent/sql-guard.ts and the real control is the
// cadence_agent role). This component owns the conversational feel — the
// message thread, auto-scroll, the input pinned at the bottom — on top of
// that plain request/response API.
//
// It is still a single-shot API underneath (nothing is stored server-side
// between requests): the console keeps the transcript client-side and resends
// the last MAX_HISTORY_TURNS (question, answer) pairs as `history` with every
// question, so a follow-up like "just the ones in Mumbai" has context.
// "New conversation" clears that transcript and starts over.

import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatINR } from '../../lib/format';
import { Pill, pillVariants } from '../ui/pill';

/** Must match lib/agent/ask.ts MAX_HISTORY_TURNS — how many turns are resent as context. */
const MAX_HISTORY_TURNS = 4;

interface AskUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

interface AskQuery {
  sql: string;
  rowCount: number | null;
  error: string | null;
}

interface AskResponse {
  question: string;
  answer: string;
  sql: string | null;
  /** Every run_sql attempt this turn, in call order — successes and rejections alike. */
  queries: AskQuery[];
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  outcome: 'success' | 'refused' | 'error';
  error: string | null;
  usage: AskUsage;
}

const EXAMPLES = [
  'Which 10 customers are most likely to churn?',
  'How many customers are in each segment?',
  'What was revenue by month this year?',
  'Which cities have the highest average order value?',
  'Which discount codes get used most?',
];

// Display-only conversion for the per-question cost. PRD-02 §F8 states the
// differentiator in rupees ("this query cost ₹0.14") and the rest of the build
// is INR throughout, but OpenRouter reports cost in USD and ai_logs.cost_usd
// stores exactly what it reported — that column stays the source of truth and
// is never converted.
//
// This rate is therefore a presentation constant, not financial data. It is
// hardcoded because there is no FX feed in this app and adding one to render a
// sub-rupee figure would be absurd; it is shown with "≈" and the exact USD is
// kept in the title attribute so nobody mistakes the rounded rupee number for
// the billed amount. Update it when it drifts enough to matter.
const USD_TO_INR = 88;

/** Sub-rupee costs need paise; formatINR rounds to whole rupees and would show ₹0. */
function formatCostINR(costUsd: number): string {
  const inr = costUsd * USD_TO_INR;
  // Below a paisa, "₹0.00" reads as free rather than cheap.
  if (inr > 0 && inr < 0.01) return '≈₹0.01';
  return `≈₹${inr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Column-name heuristics for display only. The values themselves arrive as
// Postgres produced them (numeric comes back as a string) and are never
// combined in JavaScript — formatINR formats one already-final value.
const MONEY_RE = /(total|revenue|ltv|value|aov|amount|spend|discount|price)/i;
const DATE_RE = /(_at|_date|month|day|week)$/i;

function renderCell(column: string, value: unknown) {
  if (value === null || value === undefined) return <span className="text-faint">—</span>;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);

  const text = String(value);
  if (MONEY_RE.test(column) && /^-?\d+(\.\d+)?$/.test(text)) return formatINR(text);
  if (DATE_RE.test(column) && /^\d{4}-\d{2}-\d{2}/.test(text)) return formatDateTime(text);
  return text;
}

function isNumericColumn(column: string, rows: Record<string, unknown>[]): boolean {
  const sample = rows.find((r) => r[column] !== null && r[column] !== undefined);
  if (!sample) return false;
  const v = sample[column];
  return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
}

/** Short label for the chip that opens a turn in the inspector. */
function queryLabel(result: AskResponse): string {
  const queries = result.queries.length;
  const parts = [queries === 1 ? '1 query' : `${queries} queries`];
  if (result.columns.length > 0) {
    parts.push(`${result.rowCount} row${result.rowCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/**
 * The right-hand inspector: every query the selected turn ran, then its result
 * table. This is where the width is, so the table is the full panel wide.
 */
function QueryInspector({ result, onClose }: { result: AskResponse; onClose: () => void }) {
  return (
    <aside className="flex w-[46%] min-w-[420px] max-w-[760px] flex-none flex-col overflow-hidden border-l border-hairline-soft bg-canvas">
      <div className="row-divider flex flex-none items-start gap-3 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="type-caption text-faint">Generated SQL · {queryLabel(result)}</div>
          <div className="truncate type-body-sm text-ink-soft" title={result.question}>
            {result.question}
          </div>
        </div>
        <Pill
          variant="soft"
          size="sm"
          onClick={onClose}
          aria-label="Close query inspector"
          className="flex-none px-2.5 text-muted-foreground"
        >
          ✕
        </Pill>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {result.queries.map((q, i) => (
          <div key={i} className={i > 0 ? 'mt-4 border-t border-hairline-soft pt-4' : ''}>
            {result.queries.length > 1 && (
              <div className="mb-1.5 type-caption text-faint">
                Query {i + 1} of {result.queries.length}
              </div>
            )}
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-sm bg-canvas-soft px-4 py-3 font-code text-[12px] leading-relaxed text-ink-soft">
              {q.sql}
            </pre>
            {q.error ? (
              <div className="mt-1.5 type-caption text-bad">{q.error}</div>
            ) : (
              <div className="mt-1.5 type-caption text-faint">
                {q.rowCount} row{q.rowCount === 1 ? '' : 's'}
              </div>
            )}
          </div>
        ))}

        {result.columns.length > 0 && (
          <div className="mt-3">
            <div className="mb-2 flex items-center justify-between type-caption text-faint">
              <span>Results</span>
              <span>
                {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                {result.rowCount === 500 ? ' (limit reached)' : ''}
              </span>
            </div>
            <div className="overflow-auto rounded-sm border border-hairline-soft">
              <table className="w-full border-collapse type-body-sm">
                <thead>
                  <tr className="sticky top-0 bg-canvas-soft">
                    {result.columns.map((c) => (
                      <th
                        key={c}
                        className={`whitespace-nowrap border-b border-hairline-soft px-4 py-2.5 type-caption font-normal text-muted-foreground ${isNumericColumn(c, result.rows) ? 'text-right' : 'text-left'
                          }`}
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} className="row-divider last:border-b-0">
                      {result.columns.map((c) => (
                        <td
                          key={c}
                          className={`px-4 py-2.5 align-top ${isNumericColumn(c, result.rows) ? 'whitespace-nowrap text-right' : ''
                            }`}
                        >
                          {renderCell(c, row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {result.rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={result.columns.length}
                        className="px-4 py-10 text-center type-body-sm text-muted-foreground"
                      >
                        No rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** One exchange: the user's bubble, then the assistant's answer beneath it. */
function Turn({
  result,
  active,
  onOpen,
}: {
  result: AskResponse;
  active: boolean;
  onOpen: () => void;
}) {
  const usage = result.usage;
  return (
    <div className="mb-5">
      <div className="mb-3 flex justify-end">
        <div className="max-w-[80%] rounded-md rounded-br-sm bg-ink px-5 py-3 type-body-sm text-paper">
          {result.question}
        </div>
      </div>

      <div>
        <div className={`type-body ${result.outcome === 'success' ? '' : 'text-warn'}`}>
          {result.answer}
        </div>
        {result.outcome !== 'success' && (
          <div className="mt-1.5 type-caption text-muted-foreground">
            {result.outcome === 'refused'
              ? 'Refused — no query was run.'
              : 'Blocked — the query was rejected before or by the database.'}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          {result.queries.length > 0 && (
            <button
              type="button"
              onClick={onOpen}
              className={pillVariants({ variant: active ? 'primary' : 'chip', size: 'sm' })}
            >
              SQL · {queryLabel(result)}
            </button>
          )}
          {usage && (
            <span
              className="type-caption text-faint"
              title={usage.costUsd == null ? undefined : `$${usage.costUsd.toFixed(6)} USD as billed`}
            >
              {usage.promptTokens}/{usage.completionTokens} tok ·{' '}
              {usage.costUsd == null ? 'cost n/a' : formatCostINR(usage.costUsd)} ·{' '}
              {usage.latencyMs} ms
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The waiting state. POST /api/agent is one request/response round-trip with
 * no token stream to render, so the indicator reports elapsed progress rather
 * than pretending to show output: a shimmer sweep across a label that
 * advances through the work the server is actually doing.
 */
const THINKING_STAGES = [
  'Thinking…',
  'Writing SQL…',
  'Running queries as cadence_agent…',
  'Reading the result set…',
  'Composing the answer…',
];

function ThinkingIndicator() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    // Advance while the request is in flight, then hold on the last stage
    // rather than looping back — going backwards would read as a stall.
    const id = setInterval(() => {
      setStage((s) => Math.min(s + 1, THINKING_STAGES.length - 1));
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2.5" aria-live="polite">
      <span className="thinking-dot inline-block size-1.5 rounded-full" />
      <span className="thinking-shimmer type-body-sm">{THINKING_STAGES[stage]}</span>
    </div>
  );
}

export function AskConsole() {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [turns, setTurns] = useState<AskResponse[]>([]);
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, pending]);

  async function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setQuestion('');
    setAsking(trimmed);
    setPending(true);
    setFailure(null);
    try {
      // The client holds the transcript; only the tail goes back to the
      // server, and nothing is stored there between requests.
      const history = turns
        .slice(-MAX_HISTORY_TURNS)
        .map((t) => ({ question: t.question, answer: t.answer }));
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed, history }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setFailure(typeof payload?.error === 'string' ? payload.error : 'Request failed.');
      } else {
        const result = payload as AskResponse;
        setTurns((prev) => {
          // Open the new turn in the inspector when it actually ran a query.
          if (result.queries.length > 0) setOpenTurn(prev.length);
          return [...prev, result];
        });
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setPending(false);
      setAsking(null);
    }
  }

  const inspected = openTurn != null ? turns[openTurn] : undefined;

  return (
    <div className="flex h-full overflow-hidden">
      {/* Conversation */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="row-divider flex flex-none items-center justify-between gap-3 px-6 py-4">
          <div className="min-w-0">
            <h1 className="type-heading-4">Ask Cadence.</h1>
            <div className="truncate type-caption text-muted-foreground">
              Natural language over the customer dataset · read-only{' '}
              <span className="font-code">cadence_agent</span> role · four views · 500-row cap
            </div>
          </div>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setOpenTurn(null);
                setFailure(null);
              }}
              className={`${pillVariants({ variant: 'soft', size: 'sm' })} flex-none`}
            >
              New conversation
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mx-auto max-w-3xl">
            {turns.length === 0 && !pending && (
              <div className="flex flex-col items-center gap-6 py-20 text-center">
                <div>
                  <div className="type-heading-3">What do you want to know?</div>
                  <div className="mt-2.5 type-body-lg text-muted-foreground">
                    Ask about customers, orders, segments or churn risk.
                  </div>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => void run(e)}
                      className={pillVariants({ variant: 'chip', size: 'sm' })}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <Turn
                key={i}
                result={t}
                active={openTurn === i}
                onOpen={() => setOpenTurn(openTurn === i ? null : i)}
              />
            ))}

            {pending && (
              <div className="mb-5">
                <div className="mb-3 flex justify-end">
                  <div className="max-w-[80%] rounded-md rounded-br-sm bg-ink px-5 py-3 type-body-sm text-paper">
                    {asking}
                  </div>
                </div>
                <ThinkingIndicator />
              </div>
            )}

            {failure && (
              <div className="surface-soft px-5 py-4 type-body-sm text-bad">
                {failure}
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(question);
          }}
          className="flex-none border-t border-hairline-soft bg-canvas px-6 py-4"
        >
          <div className="field-shell mx-auto flex max-w-3xl items-center gap-2 py-2 pr-2 pl-5">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={500}
              placeholder="Ask a follow-up, or a new question…"
              className="w-full flex-1 bg-transparent type-body-sm text-ink outline-none placeholder:text-faint"
            />
            <button
              type="submit"
              disabled={pending || !question.trim()}
              className={`${pillVariants({ size: 'md' })} flex-none`}
            >
              {pending ? 'Thinking…' : 'Ask'}
            </button>
          </div>
        </form>
      </div>

      {inspected && <QueryInspector result={inspected} onClose={() => setOpenTurn(null)} />}
    </div>
  );
}
