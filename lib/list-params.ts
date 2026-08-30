// Pure, framework-agnostic validation for list-page query parameters that
// arrive as untrusted URL search params (?segment=, ?page=, ?pageSize=).
//
// Deliberately NOT server-only and does NOT import ../db/index (which opens
// a pg Pool and throws without DATABASE_URL) — only ../db/schema, which is
// a pure declarative module. That keeps this file importable from a plain
// node:test run with no live database and no react-server module
// resolution, so the "invalid segment/page doesn't crash" behaviour can be
// unit tested directly rather than only through a full DB-backed request.
import * as schema from '../db/schema';

const VALID_SEGMENTS = new Set<string>(schema.segmentT.enumValues);

/**
 * True only for one of the 11 real segment_t enum values. A bare string cast
 * straight into Drizzle's eq(customerScores.segment, ...) throws at the
 * database ("invalid input value for enum segment_t") for anything else,
 * which previously 500'd /customers for any tampered URL, stale bookmark, or
 * crawler hit carrying a bogus ?segment=.
 */
export function isValidSegment(value: string): value is (typeof schema.segmentT.enumValues)[number] {
  return VALID_SEGMENTS.has(value);
}

/** Clamps an untrusted ?page= to a finite integer >= 1. Number('abc') is NaN,
 * and NaN/0/negative values reaching .offset() are all reachable by hand-
 * editing the URL. */
export function normalizePage(raw: number | undefined): number {
  return Number.isFinite(raw) && (raw as number) >= 1 ? Math.floor(raw as number) : 1;
}

/** Clamps an untrusted ?pageSize= to a finite integer in [1, max]. */
export function normalizePageSize(raw: number | undefined, max = 100, fallback = 25): number {
  return Number.isFinite(raw) && (raw as number) >= 1 ? Math.min(max, Math.floor(raw as number)) : fallback;
}

// A customer id arrives from the URL on /customer-360/[id] and from the body
// of POST /api/customers/[id]/recompute. Postgres rejects a malformed uuid
// with "invalid input syntax for type uuid", which is a 500 if it reaches the
// query — the same class of bug as the unvalidated ?segment= above.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
