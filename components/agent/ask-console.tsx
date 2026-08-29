'use client';

// Ask Cadence — the question box, the answer, the SQL panel and the result
// table (PRD-02 §F4.5, §F4.6).
//
// The SQL panel sits beside every answer and is collapsible: the answer is
// what you read, the query is what you check it against. Nothing here decides
// what is safe to run — validation is server-side (lib/agent/sql-guard.ts) and
// the real control is the cadence_agent role. This component only renders what
// POST /api/agent returns.

import { useState } from 'react';
import { formatDateTime, formatINR } from '../../lib/format';

interface AskUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

interface AskResponse {
  question: string;
  answer: string;
  sql: string | null;
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

// Column-name heuristics for display only. The values themselves arrive as
// Postgres produced them (numeric comes back as a string) and are never
// combined in JavaScript — formatINR formats one already-final value.
const MONEY_RE = /(total|revenue|ltv|value|aov|amount|spend|discount|price)/i;
const DATE_RE = /(_at|_date|month|day|week)$/i;

function renderCell(column: string, value: unknown) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
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

export function AskConsole() {
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(q: string) {
    const trimmed = q.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setFailure(typeof payload?.error === 'string' ? payload.error : 'Request failed.');
      } else {
        setResult(payload as AskResponse);
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setPending(false);
    }
  }

  const usage = result?.usage;

  return (
    <div className="px-4.5 py-4 pb-7">
      <div className="mb-3">
        <div className="text-[19px] font-semibold tracking-tight">Ask Cadence</div>
        <div className="text-xs text-muted-foreground">
          Natural language over the customer dataset. Queries run as the read-only{' '}
          <span className="font-mono">cadence_agent</span> role — four views, no writes, 500-row cap.
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(question);
        }}
        className="mb-2.5 rounded-md border border-hairline bg-card px-2.5 py-2"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">?</span>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={500}
            placeholder="Which customers are most likely to churn?"
            className="w-full flex-1 bg-transparent text-[13px] outline-none"
          />
          <button
            type="submit"
            disabled={pending || !question.trim()}
            className="rounded border border-ink bg-ink px-3 py-1.5 text-[11.5px] text-paper disabled:opacity-40"
          >
            {pending ? 'Thinking…' : 'Ask'}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-hairline pt-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => {
                setQuestion(e);
                void run(e);
              }}
              className="rounded border border-hairline bg-secondary/40 px-2 py-1 text-[10.5px] text-ink-soft hover:bg-secondary"
            >
              {e}
            </button>
          ))}
        </div>
      </form>

      {failure && (
        <div className="rounded-md border border-hairline bg-card px-3 py-2.5 text-[12px] text-bad">
          {failure}
        </div>
      )}

      {pending && (
        <div className="rounded-md border border-dashed border-hairline bg-card px-3 py-6 text-center font-mono text-[11px] text-muted-foreground">
          Generating SQL, running it as cadence_agent, then reading the rows back…
        </div>
      )}

      {result && !pending && (
        <>
          {/* Answer + SQL side by side (§F4.5) */}
          <div className="flex items-start gap-2.5">
            <div className="min-w-0 flex-1 rounded-md border border-hairline bg-card px-3 py-2.5">
              <div className="mb-1 font-mono text-[9.5px] tracking-[0.09em] text-muted-foreground">
                ANSWER
              </div>
              <div
                className={`text-[13px] leading-relaxed ${
                  result.outcome === 'success' ? '' : 'text-warn'
                }`}
              >
                {result.answer}
              </div>
              {result.outcome !== 'success' && (
                <div className="mt-1.5 font-mono text-[10.5px] text-muted-foreground">
                  {result.outcome === 'refused'
                    ? 'REFUSED — no query was run.'
                    : 'BLOCKED — the query was rejected before or by the database.'}
                </div>
              )}
            </div>

            <details
              open
              className="w-[420px] flex-none rounded-md border border-hairline bg-card px-3 py-2.5"
            >
              <summary className="cursor-pointer list-none font-mono text-[9.5px] tracking-[0.09em] text-muted-foreground">
                GENERATED SQL {result.sql ? '' : '(none)'}
              </summary>
              <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-ink-soft">
                {result.sql ?? 'No query was generated for this question.'}
              </pre>
              {result.error && (
                <div className="mt-1.5 border-t border-hairline pt-1.5 font-mono text-[10.5px] text-bad">
                  {result.error}
                </div>
              )}
            </details>
          </div>

          {/* Results (§F4.6) */}
          {result.columns.length > 0 && (
            <div className="mt-2.5 overflow-hidden rounded-md border border-hairline bg-card">
              <div className="flex items-center justify-between border-b border-hairline bg-secondary/40 px-3 py-1.75 font-mono text-[9.5px] tracking-[0.09em] text-muted-foreground">
                <span>RESULTS</span>
                <span>
                  {result.rowCount} ROW{result.rowCount === 1 ? '' : 'S'}
                  {result.rowCount === 500 ? ' (LIMIT REACHED)' : ''}
                </span>
              </div>
              <div className="max-h-[460px] overflow-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="sticky top-0 bg-card">
                      {result.columns.map((c) => (
                        <th
                          key={c}
                          className={`border-b border-hairline px-3 py-1.75 font-mono text-[9.5px] font-normal tracking-[0.09em] text-muted-foreground ${
                            isNumericColumn(c, result.rows) ? 'text-right' : 'text-left'
                          }`}
                        >
                          {c.toUpperCase()}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="border-b border-[#f2f0ec] last:border-b-0">
                        {result.columns.map((c) => (
                          <td
                            key={c}
                            className={`px-3 py-1.5 align-top ${
                              isNumericColumn(c, result.rows) ? 'text-right font-mono text-[11.5px]' : ''
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
                          className="px-3 py-6 text-center text-[12px] text-muted-foreground"
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

          {usage && (
            <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
              <span>{usage.model}</span>
              <span>
                {usage.promptTokens} prompt / {usage.completionTokens} completion tokens
              </span>
              <span>{usage.costUsd == null ? 'cost n/a' : `$${usage.costUsd.toFixed(6)}`}</span>
              <span>{usage.latencyMs} ms</span>
              <span>logged to ai_logs</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
