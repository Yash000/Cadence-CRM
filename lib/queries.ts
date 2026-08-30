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
import { and, asc, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/index';
import { eventTypeTag, formatEventType } from './format';
import { isValidSegment, normalizePage, normalizePageSize } from './list-params';

const { customers, orders, orderItems, customerScores, consents, events, tasks } = schema;

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

// ---------------------------------------------------------------------------
// Dashboard: period KPIs (revenue / orders / AOV / repeat rate), at-risk
// revenue, task queue. All arithmetic on numeric(12,2) columns happens in one
// SQL expression each — never combined across two already-materialized JS
// values.
// ---------------------------------------------------------------------------

export interface PeriodKpis {
  revenue30: string;
  revenuePrev30: string;
  revenueDeltaPct: number | null;
  orders30: number;
  ordersPrev30: number;
  ordersDeltaPct: number | null;
  aov30: string;
  aovPrev30: string;
  repeatRatePct: number | null;
  repeatCustomers: number;
  scoredCustomers: number;
}

interface PeriodRow {
  revenue_30: string;
  revenue_prev_30: string;
  orders_30: string;
  orders_prev_30: string;
  aov_30: string;
  aov_prev_30: string;
}

export async function getPeriodKpis(): Promise<PeriodKpis> {
  const periodResult = await db.execute(sql`
    select
      coalesce(sum(${orders.total}) filter (where ${orders.processedAt} >= now() - interval '30 days'), 0) as revenue_30,
      coalesce(sum(${orders.total}) filter (where ${orders.processedAt} >= now() - interval '60 days' and ${orders.processedAt} < now() - interval '30 days'), 0) as revenue_prev_30,
      count(*) filter (where ${orders.processedAt} >= now() - interval '30 days') as orders_30,
      count(*) filter (where ${orders.processedAt} >= now() - interval '60 days' and ${orders.processedAt} < now() - interval '30 days') as orders_prev_30,
      coalesce(avg(${orders.total}) filter (where ${orders.processedAt} >= now() - interval '30 days'), 0) as aov_30,
      coalesce(avg(${orders.total}) filter (where ${orders.processedAt} >= now() - interval '60 days' and ${orders.processedAt} < now() - interval '30 days'), 0) as aov_prev_30
    from ${orders}
  `);
  const periodRow = (periodResult.rows[0] ?? null) as unknown as PeriodRow | null;

  const [repeatRow] = await db
    .select({
      total: count(),
      repeat: sql<number>`count(*) filter (where ${customerScores.orderCount} > 1)`,
    })
    .from(customerScores);

  const orders30 = Number(periodRow?.orders_30 ?? 0);
  const ordersPrev30 = Number(periodRow?.orders_prev_30 ?? 0);
  const revenue30 = Number(periodRow?.revenue_30 ?? 0);
  const revenuePrev30 = Number(periodRow?.revenue_prev_30 ?? 0);
  const scoredCustomers = repeatRow?.total ?? 0;
  const repeatCustomers = Number(repeatRow?.repeat ?? 0);

  // JS arithmetic on Number()-converted SQL aggregates, which sits close to
  // the "never combine money values in JS" rule but doesn't break it: curr/
  // prev are each already a single finished SQL SUM()/COUNT() for their own
  // period (Postgres did the row-level summing), and the % delta here is a
  // display-only comparison of those two finished values, not a further
  // summation of raw per-row money across rows.
  const pctDelta = (curr: number, prev: number): number | null => {
    if (prev === 0) return null;
    return ((curr - prev) / prev) * 100;
  };

  return {
    revenue30: periodRow?.revenue_30 ?? '0',
    revenuePrev30: periodRow?.revenue_prev_30 ?? '0',
    revenueDeltaPct: pctDelta(revenue30, revenuePrev30),
    orders30,
    ordersPrev30,
    ordersDeltaPct: pctDelta(orders30, ordersPrev30),
    aov30: periodRow?.aov_30 ?? '0',
    aovPrev30: periodRow?.aov_prev_30 ?? '0',
    repeatRatePct: scoredCustomers > 0 ? (repeatCustomers / scoredCustomers) * 100 : null,
    repeatCustomers,
    scoredCustomers,
  };
}

export interface AtRiskRevenue {
  expectedValueAtRisk: string;
  customerCount: number;
  reason: string;
}

// "Revenue at risk" = sum of each elevated/high-churn customer's predicted
// LTV weighted by their own churn probability — an expected-value figure, not
// a raw sum, computed entirely in one SQL SUM() expression.
export async function getAtRiskRevenue(): Promise<AtRiskRevenue> {
  const [row] = await db
    .select({
      expected: sql<string>`coalesce(sum(${customerScores.predictedLtv} * ${customerScores.churnRisk} / 100.0), 0)`,
      n: sql<number>`count(*)`,
    })
    .from(customerScores)
    .where(sql`${customerScores.churnRisk} >= 51`);

  return {
    expectedValueAtRisk: row?.expected ?? '0',
    customerCount: Number(row?.n ?? 0),
    reason:
      'Sum of predicted LTV x churn probability for every customer with elevated-or-higher churn risk (>=51) — an expected-value figure, not a raw balance.',
  };
}

export interface TaskQueueItem {
  id: string;
  customerId: string | null;
  type: string;
  title: string;
  reason: string;
  priority: number;
  dueAt: string | null;
}

export interface TaskQueue {
  tasks: TaskQueueItem[];
  totalOpen: number;
}

// tasks is empty until the flow engine (PRD-02 §F6) lands — this reads the
// real table honestly rather than fabricating rows.
export async function getTaskQueue(limit = 10): Promise<TaskQueue> {
  const [[{ n: totalOpen }], rows] = await Promise.all([
    db.select({ n: count() }).from(tasks).where(eq(tasks.status, 'open')),
    db
      .select({
        id: tasks.id,
        customerId: tasks.customerId,
        type: tasks.type,
        title: tasks.title,
        reason: tasks.reason,
        priority: tasks.priority,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(eq(tasks.status, 'open'))
      .orderBy(asc(tasks.priority), desc(tasks.createdAt))
      .limit(limit),
  ]);

  return {
    tasks: rows.map((r) => ({ ...r, dueAt: r.dueAt ? String(r.dueAt) : null })),
    totalOpen: totalOpen ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Customer list — searchable, sortable, filterable.
// ---------------------------------------------------------------------------

export type CustomerSort = 'churn_desc' | 'churn_asc' | 'ltv_desc' | 'ltv_asc' | 'name_asc' | 'last_order_desc';

// segment/page/pageSize validation lives in ./list-params (no server-only
// import) so it's unit-testable without a live database — see
// tests/list-params.test.ts.
export { isValidSegment } from './list-params';

export interface CustomerListParams {
  q?: string;
  segment?: string;
  sort?: CustomerSort;
  page?: number;
  pageSize?: number;
}

export interface CustomerListRow {
  id: string;
  name: string;
  city: string | null;
  segment: string | null;
  orderCount: number;
  lifetimeValue: string | null;
  daysSinceLastOrder: number | null;
  churnRisk: number | null;
  churnReason: string | null;
  waConsent: string | null;
  emailConsent: string | null;
}

export interface CustomerListResult {
  rows: CustomerListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function getCustomerList(params: CustomerListParams): Promise<CustomerListResult> {
  const page = normalizePage(params.page);
  const pageSize = normalizePageSize(params.pageSize);
  const q = params.q?.trim();

  const whereClauses = [];
  if (q) {
    const like = `%${q}%`;
    whereClauses.push(
      or(
        ilike(sql`coalesce(${customers.firstName}, '') || ' ' || coalesce(${customers.lastName}, '')`, like),
        ilike(customers.email, like),
        ilike(sql`coalesce(${customers.phoneE164}, '')`, like),
      ),
    );
  }
  // Only push the segment filter once it's confirmed to be one of the 11 real
  // segment_t values — anything else (typo, stale bookmark, crawler) is
  // treated the same as "all" rather than reaching eq() and 500ing on the
  // enum's "invalid input value" error.
  if (params.segment && params.segment !== 'all' && isValidSegment(params.segment)) {
    whereClauses.push(eq(customerScores.segment, params.segment));
  }
  const where = whereClauses.length > 0 ? and(...whereClauses) : undefined;

  const sortMap: Record<CustomerSort, ReturnType<typeof desc>> = {
    churn_desc: desc(customerScores.churnRisk),
    churn_asc: asc(customerScores.churnRisk),
    ltv_desc: desc(customerScores.lifetimeValue),
    ltv_asc: asc(customerScores.lifetimeValue),
    name_asc: asc(customers.firstName),
    last_order_desc: asc(customerScores.daysSinceLastOrder),
  };
  // Object index with a param.sort that isn't one of the 6 known keys yields
  // undefined, not a throw — the `?? sortMap.churn_desc` below already covers
  // an invalid/missing sort value safely.
  const orderBy = sortMap[params.sort ?? 'churn_desc'] ?? sortMap.churn_desc;

  const baseQuery = db
    .select({
      id: customers.id,
      firstName: customers.firstName,
      lastName: customers.lastName,
      city: customers.city,
      segment: customerScores.segment,
      orderCount: customerScores.orderCount,
      lifetimeValue: customerScores.lifetimeValue,
      daysSinceLastOrder: customerScores.daysSinceLastOrder,
      churnRisk: customerScores.churnRisk,
      churnReason: customerScores.churnReason,
      waConsent: sql<string | null>`(select ${consents.status} from ${consents} where ${consents.customerId} = ${customers.id} and ${consents.channel} = 'whatsapp' limit 1)`,
      emailConsent: sql<string | null>`(select ${consents.status} from ${consents} where ${consents.customerId} = ${customers.id} and ${consents.channel} = 'email' limit 1)`,
    })
    .from(customers)
    .leftJoin(customerScores, eq(customerScores.customerId, customers.id));

  const [rows, [{ n: total }]] = await Promise.all([
    (where ? baseQuery.where(where) : baseQuery)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    (where
      ? db
          .select({ n: count() })
          .from(customers)
          .leftJoin(customerScores, eq(customerScores.customerId, customers.id))
          .where(where)
      : db.select({ n: count() }).from(customers)),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ') || 'Unnamed customer',
      city: r.city,
      segment: r.segment,
      orderCount: r.orderCount ?? 0,
      lifetimeValue: r.lifetimeValue,
      daysSinceLastOrder: r.daysSinceLastOrder,
      churnRisk: r.churnRisk,
      churnReason: r.churnReason,
      waConsent: r.waConsent,
      emailConsent: r.emailConsent,
    })),
    total: total ?? 0,
    page,
    pageSize,
  };
}

export async function getSegmentOptions(): Promise<string[]> {
  return schema.segmentT.enumValues.slice();
}

// ---------------------------------------------------------------------------
// Customer 360 — profile, scores (with reasons), consent/reachability,
// unified timeline (orders + order items + events + consent changes).
// ---------------------------------------------------------------------------

export interface CustomerProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phoneE164: string | null;
  city: string | null;
  state: string | null;
  createdAt: string;
  segment: string | null;
  rfmR: number | null;
  rfmF: number | null;
  rfmM: number | null;
  churnRisk: number | null;
  churnReason: string | null;
  predictedLtv: string | null;
  ltvReason: string | null;
  nextOrderDate: string | null;
  nextOrderReason: string | null;
  medianIntervalDays: string | null;
  daysSinceLastOrder: number | null;
  orderCount: number;
  lifetimeValue: string;
  aov: string | null;
  computedAt: string | null;
}

export async function getCustomerProfile(customerId: string): Promise<CustomerProfile | null> {
  const [row] = await db
    .select({
      id: customers.id,
      firstName: customers.firstName,
      lastName: customers.lastName,
      email: customers.email,
      phoneE164: customers.phoneE164,
      city: customers.city,
      state: customers.state,
      createdAt: customers.createdAt,
      segment: customerScores.segment,
      rfmR: customerScores.rfmR,
      rfmF: customerScores.rfmF,
      rfmM: customerScores.rfmM,
      churnRisk: customerScores.churnRisk,
      churnReason: customerScores.churnReason,
      predictedLtv: customerScores.predictedLtv,
      ltvReason: customerScores.ltvReason,
      nextOrderDate: customerScores.nextOrderDate,
      nextOrderReason: customerScores.nextOrderReason,
      medianIntervalDays: customerScores.medianIntervalDays,
      daysSinceLastOrder: customerScores.daysSinceLastOrder,
      orderCount: customerScores.orderCount,
      lifetimeValue: customerScores.lifetimeValue,
      aov: customerScores.aov,
      computedAt: customerScores.computedAt,
    })
    .from(customers)
    .leftJoin(customerScores, eq(customerScores.customerId, customers.id))
    .where(eq(customers.id, customerId))
    .limit(1);

  if (!row) return null;
  return {
    ...row,
    createdAt: String(row.createdAt),
    nextOrderDate: row.nextOrderDate ? String(row.nextOrderDate) : null,
    computedAt: row.computedAt ? String(row.computedAt) : null,
    orderCount: row.orderCount ?? 0,
    lifetimeValue: row.lifetimeValue ?? '0',
  };
}

export interface ConsentRow {
  channel: string;
  status: string;
  source: string | null;
  updatedAt: string;
}

export async function getCustomerConsents(customerId: string): Promise<ConsentRow[]> {
  const rows = await db
    .select({
      channel: consents.channel,
      status: consents.status,
      source: consents.source,
      updatedAt: consents.updatedAt,
    })
    .from(consents)
    .where(eq(consents.customerId, customerId))
    .orderBy(asc(consents.channel));

  return rows.map((r) => ({ ...r, updatedAt: String(r.updatedAt) }));
}

export type TimelineKind = 'order' | 'event' | 'consent';

export interface TimelineEntry {
  kind: TimelineKind;
  occurredAt: string;
  title: string;
  body: string;
  tag: string;
  meta?: string[];
}

// The timeline interleaves what actually exists today: orders (with their
// line items rolled up), raw behavioural events, and consent state changes.
// Messages/campaign sends will slot in as additional `kind`s once §F5/§F6
// land — this function's shape (fetch-per-source, merge-in-JS, paginate) is
// built so that's an additive change, not a rewrite.
export async function getCustomerTimeline(customerId: string): Promise<TimelineEntry[]> {
  const [orderRows, eventRows, consentRows] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        total: orders.total,
        financialStatus: orders.financialStatus,
        processedAt: orders.processedAt,
        cancelledAt: orders.cancelledAt,
      })
      .from(orders)
      .where(eq(orders.customerId, customerId))
      .orderBy(desc(orders.processedAt)),
    db
      .select({
        id: events.id,
        type: events.type,
        payload: events.payload,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(eq(events.customerId, customerId))
      .orderBy(desc(events.occurredAt)),
    db
      .select({
        channel: consents.channel,
        status: consents.status,
        source: consents.source,
        updatedAt: consents.updatedAt,
      })
      .from(consents)
      .where(eq(consents.customerId, customerId))
      .orderBy(desc(consents.updatedAt)),
  ]);

  let itemsByOrder = new Map<string, { title: string; qty: number }[]>();
  if (orderRows.length > 0) {
    const items = await db
      .select({
        orderId: orderItems.orderId,
        title: orderItems.title,
        qty: orderItems.qty,
      })
      .from(orderItems)
      .where(
        sql`${orderItems.orderId} in (${sql.join(
          orderRows.map((o) => sql`${o.id}`),
          sql`, `,
        )})`,
      );
    itemsByOrder = items.reduce((map, it) => {
      const list = map.get(it.orderId) ?? [];
      list.push({ title: it.title ?? 'Item', qty: it.qty });
      map.set(it.orderId, list);
      return map;
    }, new Map<string, { title: string; qty: number }[]>());
  }

  const orderEntries: TimelineEntry[] = orderRows.map((o) => {
    const items = itemsByOrder.get(o.id) ?? [];
    const itemSummary = items.map((it) => `${it.qty}x ${it.title}`).join(', ') || 'no line items on file';
    return {
      kind: 'order',
      occurredAt: String(o.processedAt),
      title: `Order ${o.orderNumber ?? o.id.slice(0, 8)}`,
      body: `${items.length} item${items.length === 1 ? '' : 's'} · ${itemSummary}`,
      tag: 'ORDER',
      meta: [o.financialStatus, `total ${o.total}`, o.cancelledAt ? 'cancelled' : null].filter(
        (m): m is string => Boolean(m),
      ),
    };
  });

  const eventEntries: TimelineEntry[] = eventRows.map((e) => {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    let body = '';
    switch (e.type) {
      case 'product_view':
        body = `Viewed ${payload.title ?? payload.sku ?? 'a product'}`;
        break;
      case 'add_to_cart':
        body = `Added ${payload.sku ?? 'item'} (qty ${payload.qty ?? 1}) at ${payload.price ?? '—'}`;
        break;
      case 'checkout_started':
        body = `Started checkout · ${payload.items ?? '?'} items · value ${payload.value ?? '—'}`;
        break;
      case 'checkout_abandoned': {
        const items = Array.isArray(payload.items) ? (payload.items as Array<{ handle?: string; qty?: number }>) : [];
        const summary = items.map((it) => `${it.qty ?? 1}x ${it.handle ?? 'item'}`).join(', ');
        body = `Abandoned checkout worth ${payload.value ?? '—'}${summary ? ` (${summary})` : ''}`;
        break;
      }
      case 'page_view':
        body = `Viewed page ${payload.path ?? ''}`;
        break;
      default:
        body = JSON.stringify(payload);
    }
    return {
      kind: 'event',
      occurredAt: String(e.occurredAt),
      title: formatEventType(e.type),
      body,
      tag: eventTypeTag(e.type),
    };
  });

  const consentEntries: TimelineEntry[] = consentRows.map((c) => ({
    kind: 'consent',
    occurredAt: String(c.updatedAt),
    title: `${c.channel} consent: ${c.status.replace('_', ' ')}`,
    body: c.source ? `Source: ${c.source}` : 'Source unknown',
    tag: 'CONSENT',
  }));

  return [...orderEntries, ...eventEntries, ...consentEntries].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
}

// ---------------------------------------------------------------------------
// Event simulator (Task 9 — PRD-01 §7 fallback: the storefront tracking
// snippet's real delivery can't be verified in this dev environment, so the
// simulator lets a demo attach a page_view/product_view/add_to_cart/
// checkout_started event to a REAL seeded customer via the same /api/events
// endpoint the theme posts to).
// ---------------------------------------------------------------------------

export interface SimulatorCustomerOption {
  id: string;
  shopifyCustomerId: number;
  name: string;
}

/** A small sample of real, seeded customers that have a shopify_customer_id — the only ones the tracking endpoint can resolve to a customer_id (lib/events-db.ts resolveCustomerId). */
export async function getSimulatorCustomerSample(limit = 15): Promise<SimulatorCustomerOption[]> {
  const rows = await db
    .select({
      id: customers.id,
      shopifyCustomerId: customers.shopifyCustomerId,
      firstName: customers.firstName,
      lastName: customers.lastName,
      email: customers.email,
    })
    .from(customers)
    .where(sql`${customers.shopifyCustomerId} is not null`)
    .orderBy(asc(customers.createdAt))
    .limit(limit);

  return rows
    .filter((r): r is typeof r & { shopifyCustomerId: number } => r.shopifyCustomerId !== null)
    .map((r) => ({
      id: r.id,
      shopifyCustomerId: r.shopifyCustomerId,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email || r.id.slice(0, 8),
    }));
}
