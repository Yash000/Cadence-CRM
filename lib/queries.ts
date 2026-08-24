// Server-only read queries backing the Dashboard shell page (Task 5).
//
// Scores are precomputed by scripts/recompute-scores.mjs (PRD-02 §6.2) — this
// module only ever reads customer_scores, it never computes a score on
// request. Money columns are numeric(12,2) and come back from Postgres (via
// pg) as strings; the only arithmetic done on them here is a single SQL
// SUM() executed in Postgres itself. Anywhere a money value is turned into a
// JS number below, it is solely to format one already-final value for
// display (Number(x).toLocaleString(...)) — never to add/subtract values in
// JavaScript.
import 'server-only';
import { count, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';

const { customers, orders, customerScores } = schema;

export interface DashboardTotals {
  customerCount: number;
  scoredCustomerCount: number;
  orderCount: number;
  totalRevenue: string;
}

export async function getDashboardTotals(): Promise<DashboardTotals> {
  const [[customerRow], [scoredRow], [orderRow]] = await Promise.all([
    db.select({ n: count() }).from(customers),
    db.select({ n: count() }).from(customerScores),
    db
      .select({
        n: count(),
        revenue: sql<string>`coalesce(sum(${orders.total}), 0)`,
      })
      .from(orders),
  ]);

  return {
    customerCount: customerRow?.n ?? 0,
    scoredCustomerCount: scoredRow?.n ?? 0,
    orderCount: orderRow?.n ?? 0,
    totalRevenue: orderRow?.revenue ?? '0',
  };
}

export interface SegmentRow {
  segment: string | null;
  n: number;
}

export async function getSegmentDistribution(): Promise<SegmentRow[]> {
  const rows = await db
    .select({ segment: customerScores.segment, n: count() })
    .from(customerScores)
    .groupBy(customerScores.segment)
    .orderBy(desc(count()));
  return rows;
}

export interface ChurnBucket {
  label: string;
  min: number;
  max: number;
  n: number;
}

export async function getChurnRiskBuckets(): Promise<ChurnBucket[]> {
  const rows = await db
    .select({ churnRisk: customerScores.churnRisk })
    .from(customerScores);

  const buckets: ChurnBucket[] = [
    { label: 'Low', min: 0, max: 25, n: 0 },
    { label: 'Moderate', min: 26, max: 50, n: 0 },
    { label: 'Elevated', min: 51, max: 75, n: 0 },
    { label: 'High', min: 76, max: 100, n: 0 },
  ];

  for (const { churnRisk } of rows) {
    if (churnRisk == null) continue;
    const bucket = buckets.find((b) => churnRisk >= b.min && churnRisk <= b.max);
    if (bucket) bucket.n += 1;
  }

  return buckets;
}

export interface AtRiskCustomer {
  id: string;
  name: string;
  city: string | null;
  segment: string | null;
  churnRisk: number | null;
  churnReason: string | null;
  predictedLtv: string | null;
  ltvReason: string | null;
  nextOrderDate: string | null;
  nextOrderReason: string | null;
}

export async function getTopAtRiskCustomers(limit = 10): Promise<AtRiskCustomer[]> {
  const rows = await db
    .select({
      id: customers.id,
      firstName: customers.firstName,
      lastName: customers.lastName,
      city: customers.city,
      segment: customerScores.segment,
      churnRisk: customerScores.churnRisk,
      churnReason: customerScores.churnReason,
      predictedLtv: customerScores.predictedLtv,
      ltvReason: customerScores.ltvReason,
      nextOrderDate: customerScores.nextOrderDate,
      nextOrderReason: customerScores.nextOrderReason,
    })
    .from(customerScores)
    .innerJoin(customers, eq(customerScores.customerId, customers.id))
    .orderBy(desc(customerScores.churnRisk))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unnamed customer',
    city: r.city,
    segment: r.segment,
    churnRisk: r.churnRisk,
    churnReason: r.churnReason,
    predictedLtv: r.predictedLtv,
    ltvReason: r.ltvReason,
    nextOrderDate: r.nextOrderDate,
    nextOrderReason: r.nextOrderReason,
  }));
}
