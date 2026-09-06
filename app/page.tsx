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
import { Tag } from '../components/ui/pill';

export const dynamic = 'force-dynamic';

function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="type-caption text-faint">n/a</span>;
  }
  const up = pct >= 0;
  return (
    <span className={`type-caption font-semibold ${up ? 'text-good' : 'text-bad'}`}>
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
      label: 'Revenue · 30 days',
      value: formatINR(periodKpis.revenue30),
      delta: periodKpis.revenueDeltaPct,
      why: `vs ${formatINR(periodKpis.revenuePrev30)} in the prior 30 days`,
    },
    {
      label: 'Orders · 30 days',
      value: formatCount(periodKpis.orders30),
      delta: periodKpis.ordersDeltaPct,
      why: `vs ${formatCount(periodKpis.ordersPrev30)} in the prior 30 days`,
    },
    {
      label: 'AOV · 30 days',
      value: formatINR(periodKpis.aov30),
      delta: null,
      why: `prior 30d AOV was ${formatINR(periodKpis.aovPrev30)}`,
    },
    {
      label: 'Repeat rate',
      value: formatPercent(periodKpis.repeatRatePct, 1),
      delta: null,
      why: `${formatCount(periodKpis.repeatCustomers)} of ${formatCount(periodKpis.scoredCustomers)} scored customers have 2+ orders`,
    },
  ];

  const maxSegment = Math.max(1, ...segments.map((s) => s.n));
  const maxChurn = Math.max(1, ...churnBuckets.map((b) => b.n));

  return (
    <div className="px-6 pb-12">
      <div className="mb-6">
        <h1 className="type-heading-4">Retention health.</h1>
        <p className="mt-1.5 type-body-sm text-muted-foreground">
          Live from Postgres · scores are precomputed, never calculated on load ·{' '}
          {formatCount(totals.scoredCustomerCount)}/{formatCount(totals.customerCount)} customers
          scored
        </p>
      </div>

      {/* KPI row */}
      <div className="mb-4 grid grid-cols-4 gap-4">
        {kpis.map((k) => (
          <div key={k.label} className="surface-card px-5 py-4">
            <div className="type-caption text-muted-foreground">{k.label}</div>
            <div className="mt-2.5 flex items-baseline gap-2">
              <div className="type-heading-4">{k.value}</div>
              {k.delta !== undefined && <DeltaBadge pct={k.delta} />}
            </div>
            <div className="mt-2 type-caption text-faint">{k.why}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[380px_1fr] items-start gap-4">
        <div className="flex flex-col gap-4">
          {/* Segment distribution */}
          <div className="surface-card">
            <div className="row-divider flex items-center px-5 py-4">
              <div className="type-title">Segment distribution</div>
              <div className="flex-1" />
              <div className="type-caption text-faint">
                {formatCount(totals.scoredCustomerCount)}
              </div>
            </div>
            <div className="px-5 py-2">
              {segments.map((s) => (
                <div key={s.segment ?? 'unscored'} className="flex items-center gap-3 py-2">
                  <span className="flex-1 type-body-sm">{formatSegment(s.segment)}</span>
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-field">
                    <div
                      className="h-1.5 rounded-full bg-ink"
                      style={{ width: `${(s.n / maxSegment) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right type-body-sm text-ink-soft">
                    {formatCount(s.n)}
                  </span>
                </div>
              ))}
              {segments.length === 0 && (
                <div className="py-3 type-body-sm text-muted-foreground">
                  No scored customers yet.
                </div>
              )}
            </div>
          </div>

          {/* Churn risk buckets */}
          <div className="surface-card">
            <div className="row-divider flex items-center px-5 py-4">
              <div className="type-title">Churn risk</div>
              <div className="flex-1" />
              <div className="type-caption text-faint">customer_scores.churn_risk</div>
            </div>
            <div className="px-5 py-2">
              {churnBuckets.map((b) => (
                <div key={b.label} className="flex items-center gap-3 py-2">
                  <span className="w-12 type-caption text-faint">
                    {b.min}-{b.max}
                  </span>
                  <span className="w-20 type-body-sm">{b.label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-field">
                    <div
                      className="h-1.5 rounded-full bg-ink"
                      style={{ width: `${(b.n / maxChurn) * 100}%` }}
                    />
                  </div>
                  <span className="w-10 text-right type-body-sm text-ink-soft">{b.n}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Revenue at risk — emphasis by tint fill, not by a colored band.
              The figure keeps its semantic hue as text only. */}
          <div className="surface-soft px-5 py-4">
            <div className="type-caption text-muted-foreground">Revenue at risk</div>
            <div className="mt-2 type-heading-4 text-bad">
              {formatINR(atRiskRevenue.expectedValueAtRisk)}
            </div>
            <div className="mt-2 type-caption text-muted-foreground">
              {atRiskRevenue.reason} {formatCount(atRiskRevenue.customerCount)} customers included.
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {/* Task queue */}
          <div className="surface-card">
            <div className="row-divider flex items-center gap-3 px-5 py-4">
              <div className="type-title">Today&apos;s queue</div>
              <div className="flex-1" />
              <div className="type-caption text-faint">
                {formatCount(taskQueue.totalOpen)} open · ranked by priority
              </div>
            </div>
            {taskQueue.tasks.length === 0 ? (
              <div className="px-5 py-5 type-body-sm text-muted-foreground">
                No tasks yet — the task generator lands with flows (§F6). The{' '}
                <code className="rounded-full bg-canvas-soft px-2 py-0.5 type-caption">tasks</code>{' '}
                table is empty (0 rows) on purpose; this panel reads it live rather than showing
                fabricated work.
              </div>
            ) : (
              <div>
                {taskQueue.tasks.map((t) => (
                  <div key={t.id} className="row-divider px-5 py-4 last:border-b-0">
                    <div className="flex items-center gap-3">
                      <Tag>{t.type}</Tag>
                      <span className="type-body font-semibold">{t.title}</span>
                      <div className="flex-1" />
                      {t.dueAt && (
                        <span className="type-caption text-faint">{formatDate(t.dueAt)}</span>
                      )}
                    </div>
                    <div className="mt-2 flex gap-2 type-body-sm text-muted-foreground">
                      <span className="shrink-0 text-faint">Why</span>
                      <span>{t.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top at-risk customers — every score sits next to its reason */}
          <div className="surface-card">
            <div className="row-divider flex items-center gap-3 px-5 py-4">
              <div className="type-title">Highest churn risk</div>
              <div className="flex-1" />
              <div className="type-caption text-faint">
                Top {atRisk.length} · ranked by churn risk
              </div>
            </div>
            <div>
              {atRisk.map((c) => (
                <div key={c.id} className="row-divider px-5 py-4 last:border-b-0">
                  <div className="flex items-center gap-3">
                    <span className="type-body font-semibold">{c.name}</span>
                    {c.city && <span className="type-caption text-faint">{c.city}</span>}
                    <Tag>{formatSegment(c.segment)}</Tag>
                    <div className="flex-1" />
                    <span className={`type-title ${churnRiskColor(c.churnRisk)}`}>
                      {c.churnRisk ?? '—'}
                    </span>
                  </div>
                  {c.churnReason && (
                    <div className="mt-2 type-body-sm text-muted-foreground">{c.churnReason}</div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 type-caption text-muted-foreground">
                    <span>
                      <span className="text-faint">LTV </span>
                      <span className="text-ink">{formatINR(c.predictedLtv)}</span>
                      {c.ltvReason && <span> — {c.ltvReason}</span>}
                    </span>
                    <span>
                      <span className="text-faint">Next order </span>
                      <span className="text-ink">{formatDate(c.nextOrderDate)}</span>
                      {c.nextOrderReason && <span> — {c.nextOrderReason}</span>}
                    </span>
                  </div>
                </div>
              ))}
              {atRisk.length === 0 && (
                <div className="px-5 py-5 type-body-sm text-muted-foreground">
                  No customers scored yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
