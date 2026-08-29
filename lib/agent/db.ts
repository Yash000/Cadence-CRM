// The agent's database connection — and the ONLY place AGENT_DATABASE_URL is
// read (PRD-02 §F4.3).
//
// This connects as `cadence_agent`: SELECT on exactly four views, no other
// grants, statement_timeout=5s, default_transaction_read_only=on, no bypassrls.
// scripts/verify-agent-role.mjs proves that isolation 15/15 against the live
// database and is the gate on this task.
//
// There is deliberately NO fallback to DATABASE_URL. If a query fails here
// because the role lacks permission, that IS the answer — the failure is the
// security control doing its job (a prompt injection that reaches
// `drop table customers` must die at Postgres, not at a string filter). Never
// retry a refused query on another connection, and never widen the role to
// make a query work.
import pg from 'pg';
import { guardSql } from './sql-guard';

const connectionString = process.env.AGENT_DATABASE_URL;

// Small pool: the agent is one interactive query at a time, and Supabase's own
// transaction-mode pooler sits in front of this.
let pool: pg.Pool | null = null;

function agentPool(): pg.Pool {
  if (!connectionString) {
    throw new Error(
      'AGENT_DATABASE_URL is not set. The AI agent must connect as cadence_agent; ' +
        'it must never fall back to DATABASE_URL.',
    );
  }
  if (/\/\/postgres[.:]/.test(connectionString)) {
    throw new Error(
      'AGENT_DATABASE_URL is connecting as the `postgres` superuser. Refusing to ' +
        'run agent SQL — the read-only role is the control that matters (§F4.3).',
    );
  }
  pool ??= new pg.Pool({
    connectionString,
    max: 4,
    // Client-side backstop only. The real limit is the role's own
    // statement_timeout=5s, applied by Postgres.
    query_timeout: 8_000,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  return pool;
}

export interface AgentQueryResult {
  /** The exact SQL that ran, including the enforced LIMIT. */
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  elapsedMs: number;
}

export class AgentSqlError extends Error {
  constructor(
    message: string,
    /** True when the guard refused before any connection was opened. */
    readonly rejectedByGuard: boolean,
  ) {
    super(message);
    this.name = 'AgentSqlError';
  }
}

/**
 * Validate and run one model-generated statement as `cadence_agent`.
 *
 * Both layers apply, in this order and never one instead of the other:
 * the application guard (§F4.4) first because it is cheaper and produces a
 * better message, then Postgres itself, which is the layer that actually
 * enforces anything.
 */
export async function runAgentSql(candidate: string): Promise<AgentQueryResult> {
  const guarded = guardSql(candidate);
  if (!guarded.ok) throw new AgentSqlError(guarded.reason, true);

  const startedAt = Date.now();
  try {
    const result = await agentPool().query(guarded.sql);
    return {
      sql: guarded.sql,
      columns: result.fields.map((f) => f.name),
      // pg returns numeric as string; leave every value exactly as Postgres
      // produced it. Money must not be turned into a JS number on the way past.
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rows.length,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new AgentSqlError(message, false);
  }
}
