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
import { Tag, pillVariants } from '../../components/ui/pill';

export const dynamic = 'force-dynamic';

const SORT_OPTIONS: { value: CustomerSort; label: string }[] = [
  { value: 'churn_desc', label: 'Churn risk ↓' },
  { value: 'churn_asc', label: 'Churn risk ↑' },
  { value: 'ltv_desc', label: 'LTV ↓' },
  { value: 'ltv_asc', label: 'LTV ↑' },
  { value: 'name_asc', label: 'Name A–Z' },
  { value: 'last_order_desc', label: 'Most recent order' },
];

// One template shared by the header and every row, so the two can never drift
// apart. Each column has a floor wide enough for its content at the body-sm
// (14px) size DESIGN.md specifies for table bodies; the whole grid carries a
// min-width and scrolls inside its own container rather than letting the
// flexible columns collapse — the shell is only 1024px wide at its narrowest.
const COLUMNS =
  'grid grid-cols-[minmax(200px,1.5fr)_140px_72px_112px_120px_minmax(200px,1.4fr)_92px] items-center gap-4';

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
  // same check is applied here too so the "All" chip and hidden form field
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
    <div className="px-6 pb-12">
      <div className="mb-6">
        <h1 className="type-heading-4">Customers.</h1>
        <p className="mt-1.5 type-body-sm text-muted-foreground">
          {formatCount(total)} records · synced from Shopify · scored by Cadence
        </p>
      </div>

      {/* Filter bar */}
      <form method="get" className="surface-soft mb-4 flex flex-wrap items-center gap-3 p-4">
        {/* text-input — field tint fill, no border at rest, 2px ink focus ring */}
        <div className="field-shell flex h-10 w-72 items-center gap-2 px-4">
          <span className="type-body-sm text-faint">⌕</span>
          <input
            type="text"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Name, phone, or email"
            className="w-full flex-1 bg-transparent type-body-sm text-ink outline-none placeholder:text-faint"
          />
        </div>
        {segment && <input type="hidden" name="segment" value={segment} />}
        {sort && <input type="hidden" name="sort" value={sort} />}
        <button type="submit" className={pillVariants({ variant: 'outline', size: 'sm' })}>
          Search
        </button>
        <span className="h-6 w-px bg-hairline" />
        <div className="flex flex-wrap gap-2">
          <Link
            href={buildHref({ q, sort })}
            className={pillVariants({ variant: !segment ? 'primary' : 'chip', size: 'sm' })}
          >
            All
          </Link>
          {segmentOptions.map((s) => (
            <Link
              key={s}
              href={buildHref({ q, sort, segment: s })}
              className={pillVariants({
                variant: segment === s ? 'primary' : 'chip',
                size: 'sm',
              })}
            >
              {formatSegment(s)}
            </Link>
          ))}
        </div>
        <div className="w-full" />
        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((o) => (
            <Link
              key={o.value}
              href={buildHref({ q, segment, sort: o.value })}
              className={pillVariants({
                variant: activeSort === o.value ? 'primary' : 'chip',
                size: 'sm',
              })}
            >
              {o.label}
            </Link>
          ))}
        </div>
      </form>

      {/* Table — wide content scrolls inside its own container so the page
          body never scrolls horizontally. */}
      <div className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[1000px]">
            {/* ex-data-table-cell — canvas-soft header, caption typography,
                sentence case (no all-caps, no tracking). */}
            <div
              className={`${COLUMNS} row-divider bg-canvas-soft px-5 py-3 type-caption text-muted-foreground`}
            >
              <div>Customer</div>
              <div>Segment</div>
              <div className="text-right">Orders</div>
              <div className="text-right">LTV</div>
              <div className="text-right">Last order</div>
              <div>Churn risk</div>
              <div className="text-right">Consent</div>
            </div>

            {rows.map((c) => (
              <Link
                key={c.id}
                href={`/customer-360/${c.id}`}
                className={`${COLUMNS} row-divider px-5 py-3.5 transition-colors last:border-b-0 hover:bg-canvas-soft`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 flex-none items-center justify-center rounded-full bg-canvas-soft type-caption font-semibold text-ink-soft">
                    {initials(
                      c.name.split(' ')[0] ?? null,
                      c.name.split(' ').slice(1).join(' ') || null,
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate type-body-sm font-semibold text-ink">
                      {c.name}
                    </span>
                    <span className="block truncate type-caption text-faint">{c.city ?? '—'}</span>
                  </span>
                </div>
                <div className="min-w-0">
                  <Tag className="max-w-full truncate">{formatSegment(c.segment)}</Tag>
                </div>
                <div className="text-right type-body-sm text-ink-soft">
                  {formatCount(c.orderCount)}
                </div>
                <div className="text-right type-body-sm text-ink">{formatINR(c.lifetimeValue)}</div>
                <div className="text-right type-body-sm text-ink-soft">
                  {c.daysSinceLastOrder != null ? `${c.daysSinceLastOrder}d ago` : '—'}
                </div>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="h-1.5 w-12 flex-none overflow-hidden rounded-full bg-field">
                    <span
                      className="block h-1.5 rounded-full bg-ink"
                      style={{ width: `${c.churnRisk ?? 0}%` }}
                    />
                  </span>
                  <span
                    className={`w-7 flex-none type-body-sm font-semibold ${churnRiskColor(c.churnRisk)}`}
                  >
                    {c.churnRisk ?? '—'}
                  </span>
                  <span className="min-w-0 truncate type-caption text-faint">
                    {c.churnReason ?? ''}
                  </span>
                </div>
                <div className="flex justify-end gap-1.5">
                  <span
                    className={`inline-flex h-[22px] items-center rounded-full bg-canvas-soft px-2 type-caption ${consentStatusColor(c.waConsent)}`}
                  >
                    WA
                  </span>
                  <span
                    className={`inline-flex h-[22px] items-center rounded-full bg-canvas-soft px-2 type-caption ${consentStatusColor(c.emailConsent)}`}
                  >
                    EM
                  </span>
                </div>
              </Link>
            ))}

            {rows.length === 0 && (
              <div className="px-5 py-10 text-center type-body-sm text-muted-foreground">
                No customers match this filter.
              </div>
            )}
          </div>
        </div>

        {/* Pagination */}
        <div className="flex items-center gap-3 bg-canvas-soft px-5 py-3">
          <div className="type-caption text-muted-foreground">
            Page {page} of {totalPages} · {formatCount(total)} customers
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Link
              href={buildHref({ q, segment, sort, page: Math.max(1, page - 1) })}
              className={`${pillVariants({ variant: 'outline', size: 'sm' })} ${
                page <= 1 ? 'pointer-events-none opacity-40' : ''
              }`}
            >
              ←
            </Link>
            <span className={pillVariants({ variant: 'primary', size: 'sm' })}>{page}</span>
            <Link
              href={buildHref({ q, segment, sort, page: Math.min(totalPages, page + 1) })}
              className={`${pillVariants({ variant: 'outline', size: 'sm' })} ${
                page >= totalPages ? 'pointer-events-none opacity-40' : ''
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
