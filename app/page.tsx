import {
  getChurnRiskBuckets,
  getDashboardTotals,
  getSegmentDistribution,
  getTopAtRiskCustomers,
} from '../lib/queries';
import { churnRiskColor, formatCount, formatDate, formatINR, formatSegment } from '../lib/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [totals, segments, churnBuckets, atRisk] = await Promise.all([
    getDashboardTotals(),
    getSegmentDistribution(),
    getChurnRiskBuckets(),
    getTopAtRiskCustomers(10),
  ]);

  const kpis = [
    { label: 'CUSTOMERS', value: formatCount(totals.customerCount) },
    { label: 'ORDERS', value: formatCount(totals.orderCount) },
    { label: 'REVENUE (ALL TIME)', value: formatINR(totals.totalRevenue) },
    {
      label: 'CUSTOMERS SCORED',
      value: `${formatCount(totals.scoredCustomerCount)} / ${formatCount(totals.customerCount)}`,
    },
  ];

  const maxSegment = Math.max(1, ...segments.map((s) => s.n));
  const maxChurn = Math.max(1, ...churnBuckets.map((b) => b.n));

  return (
    <div className="px-4.5 py-4 pb-7">
      <div className="mb-3.5 flex items-end gap-3">
        <div>
          <div className="text-[19px] font-semibold tracking-tight">Retention health</div>
          <div className="text-xs text-muted-foreground">
            Live from Postgres · scores are precomputed, never calculated on load
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="mb-3 grid grid-cols-4 gap-2.5">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-md border border-hairline bg-card px-3 pb-2.5 pt-2.5">
            <div className="mb-1.5 font-mono text-[9.5px] tracking-[0.1em] text-muted-foreground">
              {k.label}
            </div>
            <div className="font-mono text-[21px] font-medium tracking-tight">{k.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[360px_1fr] items-start gap-3">
        <div className="flex flex-col gap-3">
          {/* Segment distribution */}
          <div className="rounded-md border border-hairline bg-card">
            <div className="flex items-center border-b border-[#eeece7] px-3 py-2.5">
              <div className="text-[13px] font-semibold">Segment distribution</div>
              <div className="flex-1" />
              <div className="font-mono text-[10px] text-muted-foreground">
                {formatCount(totals.scoredCustomerCount)}
              </div>
            </div>
            <div className="p-3">
              <div className="flex flex-col">
                {segments.map((s) => (
                  <div
                    key={s.segment ?? 'unscored'}
                    className="flex items-center gap-2 border-b border-[#f2f0ec] py-1.5"
                  >
                    <span className="flex-1 text-[12px]">{formatSegment(s.segment)}</span>
                    <div className="h-1.5 w-20 overflow-hidden rounded bg-secondary">
                      <div
                        className="h-1.5 bg-accent-blue"
                        style={{ width: `${(s.n / maxSegment) * 100}%` }}
                      />
                    </div>
                    <span className="w-9 text-right font-mono text-[11.5px] text-ink-soft">
                      {formatCount(s.n)}
                    </span>
                  </div>
                ))}
                {segments.length === 0 && (
                  <div className="py-2 text-xs text-muted-foreground">No scored customers yet.</div>
                )}
              </div>
            </div>
          </div>

          {/* Churn risk buckets */}
          <div className="rounded-md border border-hairline bg-card">
            <div className="flex items-center border-b border-[#eeece7] px-3 py-2.5">
              <div className="text-[13px] font-semibold">Churn risk</div>
              <div className="flex-1" />
              <div className="font-mono text-[10px] text-muted-foreground">customer_scores.churn_risk</div>
            </div>
            <div className="p-3">
              {churnBuckets.map((b) => (
                <div key={b.label} className="mb-2 flex items-center gap-2">
                  <span className="w-14 font-mono text-[10px] text-muted-foreground">
                    {b.min}-{b.max}
                  </span>
                  <span className="w-16 text-[11.5px]">{b.label}</span>
                  <div className="h-1.75 flex-1 overflow-hidden rounded bg-secondary">
                    <div
                      className="h-1.75 bg-accent-blue"
                      style={{ width: `${(b.n / maxChurn) * 100}%` }}
                    />
                  </div>
                  <span className="w-9 text-right font-mono text-[11px] text-ink-soft">{b.n}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Top at-risk customers — every score sits next to its reason */}
        <div className="rounded-md border border-hairline bg-card">
          <div className="flex items-center gap-2.5 border-b border-[#eeece7] px-3 py-2.5">
            <div className="text-[13px] font-semibold">Highest churn risk</div>
            <div className="font-mono text-[10px] text-muted-foreground">
              TOP {atRisk.length} · RANKED BY CHURN RISK
            </div>
          </div>
          <div>
            {atRisk.map((c) => (
              <div key={c.id} className="border-b border-[#f2f0ec] px-3 py-2.5 last:border-b-0">
                <div className="flex items-center gap-2.5">
                  <span className="text-[13px] font-semibold">{c.name}</span>
                  {c.city && (
                    <span className="font-mono text-[10px] text-muted-foreground">{c.city}</span>
                  )}
                  <span className="rounded border border-hairline bg-secondary px-1.5 py-0.5 font-mono text-[9.5px] text-ink-soft">
                    {formatSegment(c.segment)}
                  </span>
                  <div className="flex-1" />
                  <span className={`font-mono text-[15px] font-medium ${churnRiskColor(c.churnRisk)}`}>
                    {c.churnRisk ?? '—'}
                  </span>
                </div>
                {c.churnReason && (
                  <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {c.churnReason}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-muted-foreground">
                  <span>
                    <span className="text-ink-soft">LTV </span>
                    <span className="font-mono text-foreground">{formatINR(c.predictedLtv)}</span>
                    {c.ltvReason && <span> — {c.ltvReason}</span>}
                  </span>
                  <span>
                    <span className="text-ink-soft">Next order </span>
                    <span className="font-mono text-foreground">{formatDate(c.nextOrderDate)}</span>
                    {c.nextOrderReason && <span> — {c.nextOrderReason}</span>}
                  </span>
                </div>
              </div>
            ))}
            {atRisk.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground">No customers scored yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
