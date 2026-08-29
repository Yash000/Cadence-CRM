// Pre-execution SQL validation for the AI agent (PRD-02 §F4.4).
//
// This is DEFENCE IN DEPTH, not the control. The control is the `cadence_agent`
// Postgres role behind AGENT_DATABASE_URL: it can SELECT from exactly four
// views and nothing else, it carries statement_timeout=5s and
// default_transaction_read_only=on, and it has no bypassrls. A prompt
// injection that talks the model into emitting `drop table customers` is
// refused by Postgres itself — scripts/verify-agent-role.mjs proves that,
// 15/15, against the live database.
//
// What this file adds is a cheaper, earlier, more legible refusal: the user
// gets "reads outside the four permitted views" instead of a raw Postgres
// permission error, and a query that would have been rejected never opens a
// connection at all. Nothing here may ever be treated as a substitute for the
// role. If you find yourself relaxing a rule below to make a query work, the
// answer is that the agent cannot answer that question.
//
// Deliberately no dependency on `server-only`, `pg` or any environment
// variable: this module is pure so tests/sql-guard.test.ts can hammer it with
// injection attempts without a database.

import { AGENT_VIEWS, KNOWN_COLUMNS } from './views';

export { AGENT_VIEWS };

/** Hard ceiling on returned rows (§F4.4). Appended when absent, clamped when higher. */
export const ROW_LIMIT = 500;

/** Anything longer than this is not a question we asked for. */
const MAX_SQL_LENGTH = 4000;

// Word-boundary denylist. Every one of these is either a write, a DDL, a
// transaction/session control, or a way to smuggle a second statement past the
// single-SELECT rule. `into` and `returning` are here because SELECT ... INTO
// creates a table and RETURNING only exists on data-modifying statements.
//
// A false positive is possible if one of these words appears inside a string
// literal (e.g. ... where city = 'Do'). That is the intended trade: this list
// errs towards refusing, and the refusal is visible to the user.
const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate',
  'grant', 'revoke', 'copy', 'vacuum', 'analyze', 'analyse', 'cluster',
  'reindex', 'refresh', 'call', 'do', 'merge', 'execute', 'prepare',
  'deallocate', 'declare', 'fetch', 'move', 'close', 'lock', 'listen',
  'unlisten', 'notify', 'begin', 'start', 'commit', 'rollback', 'savepoint',
  'release', 'set', 'reset', 'discard', 'comment', 'security', 'into',
  'returning', 'nextval', 'setval', 'dblink',
];

// Built from a plain string, not a template literal: `\b` inside a template
// literal is a backspace character, not a word boundary, and the resulting
// regex silently matches nothing.
const FORBIDDEN_KEYWORD_RE = new RegExp('\\b(' + FORBIDDEN_KEYWORDS.join('|') + ')\\b', 'i');

// Catalogue / filesystem / sleep reach. `pg_` covers pg_read_file, pg_ls_dir,
// pg_sleep, pg_catalog, pg_shadow and every other pg_* the model might reach
// for; none of the four views expose a pg_-prefixed column, so there is no
// legitimate query this costs us.
const CATALOGUE_RE = /\bpg_|information_schema|\blo_(import|export)\b/i;

// Table references: the identifier immediately after FROM or JOIN. A
// subquery (`from (select ...)`) does not match here because the capture must
// start with a letter or underscore — the subquery's own FROM is matched on
// its own, which is exactly what we want.
const TABLE_REF_RE = /\b(?:from|join)\s+("?[A-Za-z_][\w$]*"?(?:\s*\.\s*"?[\w$]+"?)*)/gi;

// A trailing LIMIT n [OFFSET m] on the OUTER query. Anchored to the end so a
// LIMIT inside a subquery is not mistaken for the outer one.
const TRAILING_LIMIT_RE = /\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i;

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/**
 * Validate model-generated SQL and return the exact string that may be
 * executed. The returned `sql` is the only thing callers may run — it carries
 * the enforced LIMIT.
 */
export function guardSql(raw: unknown): GuardResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'The model did not return SQL.' };
  }

  // Models like to wrap SQL in a markdown fence. Unwrapping one is
  // normalisation, not permissiveness — everything below still applies.
  let sql = raw.trim();
  const fenced = /^```(?:sql)?\s*([\s\S]*?)\s*```$/i.exec(sql);
  if (fenced) sql = fenced[1].trim();

  if (!sql) return { ok: false, reason: 'The model returned an empty query.' };
  if (sql.length > MAX_SQL_LENGTH) {
    return { ok: false, reason: `Query is longer than ${MAX_SQL_LENGTH} characters.` };
  }

  // One optional trailing statement terminator is tolerated; any other
  // semicolon means a second statement is being smuggled in.
  sql = sql.replace(/;\s*$/, '').trim();
  if (sql.includes(';')) {
    return { ok: false, reason: 'Only a single statement is allowed (semicolon found).' };
  }

  if (/--|\/\*|\*\//.test(sql)) {
    return { ok: false, reason: 'SQL comments are not allowed.' };
  }

  if (/\$\d/.test(sql)) {
    return { ok: false, reason: 'Bind parameters are not allowed; the query must be self-contained.' };
  }

  if (!/^select\b/i.test(sql)) {
    return { ok: false, reason: 'Only a single SELECT is allowed (CTEs and other statements are not).' };
  }

  const keyword = FORBIDDEN_KEYWORD_RE.exec(sql);
  if (keyword) {
    return { ok: false, reason: `Forbidden keyword "${keyword[1].toLowerCase()}" — this agent is read-only.` };
  }

  if (CATALOGUE_RE.test(sql)) {
    return { ok: false, reason: 'System catalogues and server-side file access are not available.' };
  }

  if (/\blimit\s+all\b/i.test(sql)) {
    return { ok: false, reason: `LIMIT ALL is not allowed; the row limit is ${ROW_LIMIT}.` };
  }

  const referenced = new Set<string>();
  for (const match of sql.matchAll(TABLE_REF_RE)) {
    const name = match[1].replace(/["\s]/g, '').toLowerCase();
    if ((AGENT_VIEWS as readonly string[]).includes(name)) {
      referenced.add(name);
      continue;
    }
    // `extract(month from processed_at)` and `substring(x from y)` put a
    // COLUMN after FROM, not a relation. A name that is a real column of one
    // of the four views is that case — it is not a table reference and it does
    // not count as one. Anything else is reaching outside the views.
    if (KNOWN_COLUMNS.has(name)) continue;

    return {
      ok: false,
      reason:
        `"${name}" is outside the four views this agent may read ` +
        `(${AGENT_VIEWS.join(', ')}).`,
    };
  }

  if (referenced.size === 0) {
    return { ok: false, reason: 'Query does not read any of the four permitted views.' };
  }

  // Force the row cap (§F4.4).
  const limit = TRAILING_LIMIT_RE.exec(sql);
  if (!limit) {
    sql = `${sql} limit ${ROW_LIMIT}`;
  } else if (Number(limit[1]) > ROW_LIMIT) {
    sql = `${sql.slice(0, limit.index)}limit ${ROW_LIMIT}${limit[2] ?? ''}`;
  }

  return { ok: true, sql };
}
