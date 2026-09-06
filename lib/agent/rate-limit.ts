// Per-IP rate limiting. Written for POST /api/agent, now also used by
// POST /api/events — callers pass their own limit and namespace their key
// (see EVENTS_RATE_LIMIT and the call site in app/api/events/route.ts) so the
// two endpoints get separate budgets out of one shared window map.
//
// This route is the only one in the app that spends real money: every question
// is ~$0.002 of OpenRouter credit against a live key, returns up to 500 rows of
// (masked) customer data, and holds one of four agent pool connections for up
// to the role's 5s statement_timeout. Authentication is deferred to PRD-02 §F9;
// until it lands, a fixed window per IP blunts unmetered spend and pool
// exhaustion for the cost of a Map.
//
// Deliberately in-memory, and deliberately honest about what that means: the
// counter is per server process, so it resets on deploy and does not hold
// across multiple instances, and an attacker with many source addresses is not
// stopped by it. It is a cheap floor, not the real control — the real control
// is auth, and after that a shared counter at the edge.

/** Requests allowed per IP per window for POST /api/agent. */
export const RATE_LIMIT = 10;

// Storefront tracking is ordinary browsing traffic, not a paid model call: one
// shopper moving through a few product pages legitimately fires several events
// a minute, and a shared office or mobile NAT puts many shoppers behind one
// address. Set well above real browsing so it never truncates a genuine
// session, but low enough that an unauthenticated writer cannot fill `events`
// unmetered from a single address.
export const EVENTS_RATE_LIMIT = 120;

// The inbound channel simulator (PRD-02 §F5.11) writes a conversation + message
// per call. A rep clicking through a demo sends a handful a minute; this is well
// above that and far below anything that could bloat the tables from one IP.
export const INBOX_RATE_LIMIT = 60;

/** Window length in milliseconds. */
export const RATE_WINDOW_MS = 60_000;

/** Stop tracking addresses once the map gets this large (crude memory bound). */
const MAX_TRACKED_IPS = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets — the Retry-After value. */
  retryAfterSeconds: number;
}

/**
 * The caller's address. `x-forwarded-for` is only trustworthy behind a proxy
 * that sets it (Vercel does); locally it is absent and everything shares the
 * 'local' bucket, which is the correct conservative behaviour for a limiter.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'local';
}

export function checkRateLimit(
  key: string,
  now = Date.now(),
  limit = RATE_LIMIT,
): RateLimitResult {
  // Sweep expired entries before the map can grow without bound.
  if (windows.size > MAX_TRACKED_IPS) {
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
    }
  }

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterSeconds };
}

/** Test-only: forget every window. */
export function resetRateLimits(): void {
  windows.clear();
}
