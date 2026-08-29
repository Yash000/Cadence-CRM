import {
  getAtRiskRevenue,
  getChurnRiskBuckets,
  getDashboardTotals,
  getPeriodKpis,
  getSegmentDistribution,
  getTaskQueue,
  getTopAtRiskCustomers,
} from '../lib/queries';
import {
  churnRiskColor,
  formatCount,
  formatDate,
  formatINR,
  formatPercent,
  formatSegment,
} from '../lib/format';

export const dynamic = 'force-dynamic';

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="font-mono text-[11px] text-muted-foreground">n/a</span>;
  }
  const up = pct >= 0;
  return (
    <span className={`font-mono text-[11px] ${up ? 'text-good' : 'text-bad'}`}>
      {up ? '+' : ''}
      {pct.toFixed(1)}%
    </span>
  );
}

export default async function DashboardPage() {
  const [totals, periodKpis, segments, churnBuckets, atRiskRevenue, taskQueue, atRisk] =
    await Promise.all([
      getDashboardTotals(),
      getPeriodKpis(),
      getSegmentDistribution(),
      getChurnRiskBuckets(),
      getAtRiskRevenue(),
      getTaskQueue(8),
      getTopAtRiskCustomers(10),
    ]);

  const kpis = [
    {
      label: 'REVENUE · 30D',
      value: formatINR(periodKpis.revenue30),
      delta: periodKpis.revenueDeltaPct,
      why: `vs ${formatINR(periodKpis.revenuePrev30)} in the prior 30 days`,
    },
    {
      label: 'ORDERS · 30D',
      value: formatCount(periodKpis.orders30),
      delta: periodKpis.ordersDeltaPct,
      why: `vs ${formatCount(periodKpis.ordersPrev30)} in the prior 30 days`,
    },
    {
      label: 'AOV · 30D',
      value: formatINR(periodKpis.aov30),
      delta: null,
      why: `prior 30d AOV was ${formatINR(periodKpis.aovPrev30)}`,
    },
    {
      label: 'REPEAT RATE',
      value: formatPercent(periodKpis.repeatRatePct, 1),
      delta: null,
      why: `${formatCount(periodKpis.repeatCustomers)} of ${formatCount(periodKpis.scoredCustomers)} scored customers have 2+ orders`,
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
            Live from Postgres · scores are precomputed, never calculated on load ·{' '}
            {formatCount(totals.scoredCustomerCount)}/{formatCount(totals.customerCount)} customers scored
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
            <div className="flex items-baseline gap-2">
              <div className="font-mono text-[21px] font-medium tracking-tight">{k.value}</div>
              {k.delta !== undefined && <DeltaBadge pct={k.delta} />}
            </div>
            <div className="mt-1.5 text-[10.5px] leading-snug text-muted-foreground">{k.why}</div>
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

          {/* Revenue at risk */}
          <div className="rounded-md border border-[#f0ddd7] bg-[#fbf1ee] p-3">
            <div className="mb-1 font-mono text-[9.5px] tracking-[0.1em] text-[#a5503a]">
              REVENUE AT RISK
            </div>
            <div className="font-mono text-[20px] font-medium text-[#8f3826]">
              {formatINR(atRiskRevenue.expectedValueAtRisk)}
            </div>
            <div className="mt-1 text-[10.5px] leading-relaxed text-[#7a5449]">
              {atRiskRevenue.reason} {formatCount(atRiskRevenue.customerCount)} customers included.
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* Task queue */}
          <div className="rounded-md border border-hairline bg-card">
            <div className="flex items-center gap-2.5 border-b border-[#eeece7] px-3 py-2.5">
              <div className="text-[13px] font-semibold">Today&apos;s queue</div>
              <div className="font-mono text-[10px] text-muted-foreground">
                {formatCount(taskQueue.totalOpen)} OPEN · RANKED BY PRIORITY
              </div>
            </div>
            {taskQueue.tasks.length === 0 ? (
              <div className="px-3 py-4 text-[11.5px] leading-relaxed text-muted-foreground">
                No tasks yet — the task generator lands with flows (§F6). The{' '}
                <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[10.5px]">tasks</code>{' '}
                table is empty (0 rows) on purpose; this panel reads it live rather than showing
                fabricated work.
              </div>
            ) : (
              <div>
                {taskQueue.tasks.map((t) => (
                  <div key={t.id} className="border-b border-[#f2f0ec] px-3 py-2.5 last:border-b-0">
                    <div className="flex items-center gap-2.5">
                      <span className="rounded border border-hairline bg-secondary px-1.5 py-0.5 font-mono text-[9.5px] text-ink-soft">
                        {t.type}
                      </span>
                      <span className="text-[13px] font-semibold">{t.title}</span>
                      <div className="flex-1" />
                      {t.dueAt && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {formatDate(t.dueAt)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex gap-2 text-[11px] leading-relaxed text-muted-foreground">
                      <span className="font-mono text-[9.5px] text-ink-soft">WHY</span>
                      <span>{t.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
    </div>
  );
}
