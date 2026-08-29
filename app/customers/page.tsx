import Link from 'next/link';
import { getCustomerList, getSegmentOptions, isValidSegment, type CustomerSort } from '../../lib/queries';
import {
  churnRiskColor,
  consentStatusColor,
  formatCount,
  formatINR,
  formatSegment,
  initials,
} from '../../lib/format';

export const dynamic = 'force-dynamic';

const SORT_OPTIONS: { value: CustomerSort; label: string }[] = [
  { value: 'churn_desc', label: 'Churn risk ↓' },
  { value: 'churn_asc', label: 'Churn risk ↑' },
  { value: 'ltv_desc', label: 'LTV ↓' },
  { value: 'ltv_asc', label: 'LTV ↑' },
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'last_order_desc', label: 'Most recent order' },
];

function buildHref(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && v !== 'all') sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `/customers?${qs}` : '/customers';
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  // A tampered/stale/crawled URL can carry any string here — getCustomerList
  // already ignores anything that isn't a real segment_t value, but that
  // same check is applied here too so the "ALL" chip and hidden form field
  // reflect reality (a bogus segment renders as no filter, not as itself).
  const rawSegment = typeof sp.segment === 'string' ? sp.segment : undefined;
  const segment = rawSegment && isValidSegment(rawSegment) ? rawSegment : undefined;
  const sort = (typeof sp.sort === 'string' ? sp.sort : undefined) as CustomerSort | undefined;
  const page = sp.page ? Math.max(1, Number(sp.page) || 1) : 1;
  const pageSize = 25;

  const [{ rows, total }, segmentOptions] = await Promise.all([
    getCustomerList({ q, segment, sort, page, pageSize }),
    getSegmentOptions(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeSort = sort ?? 'churn_desc';

  return (
    <div className="px-4.5 py-4 pb-7">
      <div className="mb-3 flex items-end gap-3">
        <div>
          <div className="text-[19px] font-semibold tracking-tight">Customers</div>
          <div className="text-xs text-muted-foreground">
            {formatCount(total)} records · synced from Shopify · scored by Cadence
          </div>
        </div>
      </div>

      {/* Filter bar */}
      <form
        method="get"
        className="mb-2.5 flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-card px-2.5 py-2"
      >
        <div className="flex w-64 items-center gap-1.5 rounded border border-hairline bg-secondary/40 px-2 py-1.5">
          <span className="font-mono text-[11px] text-muted-foreground">⌕</span>
          <input
            type="text"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Name, phone, or email"
            className="w-full flex-1 bg-transparent text-[12px] outline-none"
          />
        </div>
        {segment && <input type="hidden" name="segment" value={segment} />}
        {sort && <input type="hidden" name="sort" value={sort} />}
        <button
          type="submit"
          className="rounded border border-hairline bg-card px-2.5 py-1.5 text-[11.5px] hover:bg-secondary"
        >
          Search
        </button>
        <div className="h-5 w-px bg-hairline" />
        <div className="flex flex-wrap gap-1.5">
          <Link
            href={buildHref({ q, sort })}
            className={`rounded border px-2 py-1 font-mono text-[10.5px] ${
              !segment ? 'border-ink bg-ink text-paper' : 'border-hairline bg-card text-ink-soft hover:bg-secondary'
            }`}
          >
            ALL
          </Link>
          {segmentOptions.map((s) => (
            <Link
              key={s}
              href={buildHref({ q, sort, segment: s })}
              className={`rounded border px-2 py-1 font-mono text-[10.5px] ${
                segment === s
                  ? 'border-ink bg-ink text-paper'
                  : 'border-hairline bg-card text-ink-soft hover:bg-secondary'
              }`}
            >
              {formatSegment(s).toUpperCase()}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap gap-1.5">
          {SORT_OPTIONS.map((o) => (
            <Link
              key={o.value}
              href={buildHref({ q, segment, sort: o.value })}
              className={`rounded border px-2 py-1 text-[10.5px] ${
                activeSort === o.value
                  ? 'border-ink bg-ink text-paper'
                  : 'border-hairline bg-card text-ink-soft hover:bg-secondary'
              }`}
            >
              {o.label}
            </Link>
          ))}
        </div>
      </form>

      {/* Table */}
      <div className="overflow-hidden rounded-md border border-hairline bg-card">
        <div className="grid grid-cols-[1fr_140px_64px_100px_100px_1fr_110px] gap-0 border-b border-hairline bg-secondary/40 px-3 py-1.75 font-mono text-[9.5px] tracking-[0.09em] text-muted-foreground">
          <div>CUSTOMER</div>
          <div>SEGMENT</div>
          <div className="text-right">ORD</div>
          <div className="text-right">LTV</div>
          <div className="text-right">LAST ORDER</div>
          <div className="pl-3.5">CHURN RISK</div>
          <div>CONSENT</div>
        </div>
        {rows.map((c) => (
          <Link
            key={c.id}
            href={`/customer-360/${c.id}`}
            className="grid grid-cols-[1fr_140px_64px_100px_100px_1fr_110px] items-center gap-0 border-b border-[#f2f0ec] px-3 py-2 last:border-b-0 hover:bg-secondary/30"
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-5.5 w-5.5 flex-none items-center justify-center rounded-full bg-secondary font-mono text-[9.5px] font-semibold text-ink-soft">
                {initials(c.name.split(' ')[0] ?? null, c.name.split(' ').slice(1).join(' ') || null)}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium">{c.name}</div>
                <div className="font-mono text-[9.5px] text-muted-foreground">{c.city ?? '—'}</div>
              </div>
            </div>
            <div>
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10.5px] font-medium text-ink-soft">
                {formatSegment(c.segment)}
              </span>
            </div>
            <div className="text-right font-mono text-[12px] text-ink-soft">
              {formatCount(c.orderCount)}
            </div>
            <div className="text-right font-mono text-[12px] text-foreground">
              {formatINR(c.lifetimeValue)}
            </div>
            <div className="text-right font-mono text-[11.5px] text-ink-soft">
              {c.daysSinceLastOrder != null ? `${c.daysSinceLastOrder}d ago` : '—'}
            </div>
            <div className="flex items-center gap-2 pl-3.5">
              <div className="h-1.25 w-11 flex-none overflow-hidden rounded bg-secondary">
                <div
                  className="h-1.25 bg-accent-blue"
                  style={{ width: `${c.churnRisk ?? 0}%` }}
                />
              </div>
              <span className={`font-mono text-[11.5px] font-medium ${churnRiskColor(c.churnRisk)}`}>
                {c.churnRisk ?? '—'}
              </span>
              <span className="truncate text-[10px] text-muted-foreground">{c.churnReason ?? ''}</span>
            </div>
            <div className="flex gap-1">
              <span
                className={`rounded border border-hairline px-1 py-0.5 font-mono text-[9px] ${consentStatusColor(c.waConsent)}`}
              >
                WA
              </span>
              <span
                className={`rounded border border-hairline px-1 py-0.5 font-mono text-[9px] ${consentStatusColor(c.emailConsent)}`}
              >
                EM
              </span>
            </div>
          </Link>
        ))}
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No customers match this filter.
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center gap-2 bg-secondary/40 px-3 py-2">
          <div className="font-mono text-[11px] text-muted-foreground">
            Page {page} of {totalPages} · {formatCount(total)} customers
          </div>
          <div className="flex-1" />
          <div className="flex gap-1">
            <Link
              href={buildHref({ q, segment, sort, page: Math.max(1, page - 1) })}
              className={`rounded border border-hairline bg-card px-2 py-1 font-mono text-[11px] ${
                page <= 1 ? 'pointer-events-none opacity-40' : 'hover:bg-secondary'
              }`}
            >
              ←
            </Link>
            <span className="rounded border border-ink bg-ink px-2 py-1 font-mono text-[11px] text-paper">
              {page}
            </span>
            <Link
              href={buildHref({ q, segment, sort, page: Math.min(totalPages, page + 1) })}
              className={`rounded border border-hairline bg-card px-2 py-1 font-mono text-[11px] ${
                page >= totalPages ? 'pointer-events-none opacity-40' : 'hover:bg-secondary'
              }`}
            >
              →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
