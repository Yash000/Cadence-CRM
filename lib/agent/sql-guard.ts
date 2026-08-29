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
// The relation check used to be a regex that only looked at the identifier
// immediately after FROM/JOIN. That silently ignored relations 2..n of a
// comma-separated FROM list, so `select * from v_customer_360, customers`
// passed the guard (review of Task 8). Postgres refused it — the layering did
// its job — but the guard's own claim was false, so the check is now a real
// tokeniser that walks every item in every FROM list. See checkFromList below.
//
// Deliberately no dependency on `server-only`, `pg` or any environment
// variable: this module is pure so tests/sql-guard.test.ts can hammer it with
// injection attempts without a database.

import { AGENT_VIEWS } from './views';

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

// Functions that reach outside the four views wherever they appear — in the
// select list, in a WHERE clause, anywhere. query_to_xml() takes a query as a
// STRING, so no amount of relation checking sees the table it names; xmltable
// and generate_series are unbounded row sources. All three reached Postgres
// under the old regex (review of Task 8); generate_series(1,100000000) was
// stopped only by the role's 5s statement_timeout, which is a backstop, not a
// plan.
const DANGEROUS_FUNCTION_RE =
  /\b(generate_series|generate_subscripts|xmltable|query_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|cursor_to_xml|dblink\w*|to_regclass|current_setting|set_config|txid_\w*|has_\w+_privilege)\s*\(/i;

/**
 * The only set-returning function allowed in a FROM list. The views expose
 * array columns (collections, product_titles, discount_codes) and unnest is
 * the only way to aggregate over them, so several few-shot examples need it.
 */
const FROM_FUNCTION_ALLOWLIST = new Set(['unnest']);

/**
 * Functions whose SQL syntax puts a keyword FROM inside the parentheses —
 * `extract(month from processed_at)`, `substring(x from 1 for 3)`. That FROM
 * introduces no relation, so it is skipped. This replaces the old heuristic of
 * "the token after FROM is a known column name", which would have let a future
 * table sharing a column's name through (`join segment on true`).
 */
const FROM_INSIDE_FUNCTION = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

/** Words that end a FROM item; anything after one is a different clause. */
const ITEM_END_WORDS = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'window', 'union',
  'intersect', 'except', 'on', 'using', 'fetch', 'for', 'join', 'inner',
  'left', 'right', 'full', 'cross', 'natural', 'as',
]);

// A trailing LIMIT n [OFFSET m] on the OUTER query. Anchored to the end so a
// LIMIT inside a subquery is not mistaken for the outer one.
const TRAILING_LIMIT_RE = /\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i;

export type GuardResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenKind = 'word' | 'ident' | 'num' | 'string' | 'punct';

interface Token {
  kind: TokenKind;
  /** Lowercased text. String literals carry no text — their contents are data. */
  text: string;
  /** Parenthesis nesting depth. `(` and `)` both carry the OUTER depth. */
  depth: number;
  /** The word immediately before the nearest enclosing `(`, or null at depth 0. */
  ctx: string | null;
}

/**
 * Good enough for this job, and only this job: comments, semicolons and bind
 * parameters are already rejected before it runs, so the input is one
 * statement with no comment syntax in it. String literals are consumed whole
 * (including '' escaping) so their contents can never be mistaken for SQL.
 */
function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  const ctxStack: (string | null)[] = [];
  const ctx = () => (ctxStack.length > 0 ? ctxStack[ctxStack.length - 1] : null);
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (c === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ kind: 'string', text: '', depth, ctx: ctx() });
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < sql.length && sql[j] !== '"') {
        out += sql[j];
        j++;
      }
      i = j + 1;
      tokens.push({ kind: 'ident', text: out.toLowerCase(), depth, ctx: ctx() });
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[\w$]/.test(sql[j])) j++;
      tokens.push({ kind: 'word', text: sql.slice(i, j).toLowerCase(), depth, ctx: ctx() });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < sql.length && /[\w.]/.test(sql[j])) j++;
      tokens.push({ kind: 'num', text: sql.slice(i, j).toLowerCase(), depth, ctx: ctx() });
      i = j;
      continue;
    }

    if (c === '(') {
      const previous = tokens[tokens.length - 1];
      tokens.push({ kind: 'punct', text: '(', depth, ctx: ctx() });
      ctxStack.push(previous && previous.kind === 'word' ? previous.text : null);
      depth++;
      i++;
      continue;
    }

    if (c === ')') {
      depth = Math.max(0, depth - 1);
      ctxStack.pop();
      tokens.push({ kind: 'punct', text: ')', depth, ctx: ctx() });
      i++;
      continue;
    }

    tokens.push({ kind: 'punct', text: c, depth, ctx: ctx() });
    i++;
  }

  return tokens;
}

/** Index just past the `)` matching the `(` at `open`. */
function skipParens(tokens: Token[], open: number): number {
  const outerDepth = tokens[open].depth;
  for (let j = open + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind === 'punct' && t.text === ')' && t.depth === outerDepth) return j + 1;
  }
  return tokens.length;
}

/**
 * The name inside a group that is nothing but a parenthesised relation —
 * `(customers)`, `((customers))`, `(auth.users)` — or null for anything else
 * (a subquery, a join tree, an aliased item).
 *
 * Re-review of Task 8 found that skipParens treated every `(` as a subquery or
 * join tree and never looked at a lone identifier inside one, so
 * `select * from v_customer_360, (customers)` passed the guard. Postgres
 * rejects that as a syntax error rather than a permission error — not
 * exploitable, but classified as `error` instead of `refused`, the same tier as
 * the non-integer LIMIT gap.
 */
function bareParenthesisedRelation(tokens: Token[], open: number): string | null {
  let j = open + 1;

  // `((customers))` — unwrap redundant nesting before deciding.
  if (tokens[j]?.kind === 'punct' && tokens[j].text === '(') {
    const inner = bareParenthesisedRelation(tokens, j);
    if (!inner) return null;
    const after = skipParens(tokens, j);
    return tokens[after]?.kind === 'punct' && tokens[after].text === ')' ? inner : null;
  }

  if (tokens[j]?.kind !== 'word' && tokens[j]?.kind !== 'ident') return null;
  let name = tokens[j].text;
  j++;
  while (
    tokens[j]?.kind === 'punct' &&
    tokens[j].text === '.' &&
    (tokens[j + 1]?.kind === 'word' || tokens[j + 1]?.kind === 'ident')
  ) {
    name += '.' + tokens[j + 1].text;
    j += 2;
  }

  const closing = tokens[j];
  if (closing?.kind === 'punct' && closing.text === ')' && closing.depth === tokens[open].depth) {
    return name;
  }
  return null;
}

/** A group that opens with SELECT/VALUES/TABLE is a subquery, not a join tree. */
function opensSubquery(tokens: Token[], open: number): boolean {
  const first = tokens[open + 1];
  return (
    first?.kind === 'word' &&
    (first.text === 'select' || first.text === 'values' || first.text === 'table')
  );
}

/**
 * Walk one FROM/JOIN item list from `start`, validating EVERY relation in it —
 * including the second and later entries of a comma-separated list, which is
 * exactly what the old regex missed.
 *
 * Returns a refusal reason, or null when every item is acceptable. Views that
 * were genuinely read are added to `referenced`.
 */
function checkFromList(tokens: Token[], start: number, referenced: Set<string>): string | null {
  const baseDepth = tokens[start - 1].depth;
  let i = start;

  for (;;) {
    while (
      i < tokens.length &&
      tokens[i].kind === 'word' &&
      (tokens[i].text === 'lateral' || tokens[i].text === 'only')
    ) {
      i++;
    }

    const token = tokens[i];
    if (!token || token.depth < baseDepth) return null;
    // The `)` that closes the group this list lives in — the list is over.
    if (token.kind === 'punct' && token.text === ')') return null;

    if (token.kind === 'punct' && token.text === '(') {
      const bare = bareParenthesisedRelation(tokens, i);
      if (bare) {
        // Name the real problem when there is one; `(customers)` is a blocked
        // relation first and bad grammar second.
        if (!(AGENT_VIEWS as readonly string[]).includes(bare)) {
          return (
            `"${bare}" is outside the four views this agent may read ` +
            `(${AGENT_VIEWS.join(', ')}).`
          );
        }
        return 'A relation wrapped in parentheses is not a valid FROM item; drop the parentheses.';
      }
      // A subquery's own FROM is a separate FROM token and is validated by the
      // main loop on its own terms. A parenthesised JOIN TREE is not — its
      // leading relation belongs to this list, so recurse into it.
      if (!opensSubquery(tokens, i)) {
        const reason = checkFromList(tokens, i + 1, referenced);
        if (reason) return reason;
      }
      i = skipParens(tokens, i);
    } else if (token.kind === 'word' || token.kind === 'ident') {
      let name = token.text;
      let j = i + 1;
      while (
        tokens[j]?.kind === 'punct' &&
        tokens[j].text === '.' &&
        (tokens[j + 1]?.kind === 'word' || tokens[j + 1]?.kind === 'ident')
      ) {
        name += '.' + tokens[j + 1].text;
        j += 2;
      }

      if (tokens[j]?.kind === 'punct' && tokens[j].text === '(') {
        // A set-returning function standing in for a relation.
        if (!FROM_FUNCTION_ALLOWLIST.has(name)) {
          return `"${name}(...)" is not an allowed row source; only unnest() may stand in for a relation.`;
        }
        i = skipParens(tokens, j);
      } else {
        if (!(AGENT_VIEWS as readonly string[]).includes(name)) {
          return (
            `"${name}" is outside the four views this agent may read ` +
            `(${AGENT_VIEWS.join(', ')}).`
          );
        }
        referenced.add(name);
        i = j;
      }
    } else {
      return 'Unexpected token in the FROM list.';
    }

    // Alias: optional AS, optional name, optional column alias list.
    if (tokens[i]?.kind === 'word' && tokens[i].text === 'as') i++;
    if (
      (tokens[i]?.kind === 'word' || tokens[i]?.kind === 'ident') &&
      !ITEM_END_WORDS.has(tokens[i].text)
    ) {
      i++;
    }
    if (tokens[i]?.kind === 'punct' && tokens[i].text === '(') i = skipParens(tokens, i);

    // A comma continues the list; anything else ends it.
    if (tokens[i]?.kind === 'punct' && tokens[i].text === ',' && tokens[i].depth >= baseDepth) {
      i++;
      continue;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------

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

  const dangerous = DANGEROUS_FUNCTION_RE.exec(sql);
  if (dangerous) {
    return {
      ok: false,
      reason: `Function "${dangerous[1].toLowerCase()}()" is not available to this agent.`,
    };
  }

  if (/\blimit\s+all\b/i.test(sql)) {
    return { ok: false, reason: `LIMIT ALL is not allowed; the row limit is ${ROW_LIMIT}.` };
  }

  const tokens = lex(sql);

  // Every LIMIT must take a plain integer. `limit (100000)` and `limit 5e5`
  // used to pass here and then collect a second appended LIMIT, reaching
  // Postgres as a syntax error that was logged as `error` rather than
  // `refused` — safe, but misclassified.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== 'word' || tokens[i].text !== 'limit') continue;
    const argument = tokens[i + 1];
    if (!argument || argument.kind !== 'num' || !/^\d+$/.test(argument.text)) {
      return { ok: false, reason: 'LIMIT must be a plain integer.' };
    }
  }

  const referenced = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word') continue;
    if (token.text !== 'from' && token.text !== 'join') continue;
    // `extract(month from processed_at)` — that FROM introduces no relation.
    if (token.text === 'from' && token.ctx && FROM_INSIDE_FUNCTION.has(token.ctx)) continue;

    const reason = checkFromList(tokens, i + 1, referenced);
    if (reason) return { ok: false, reason };
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
