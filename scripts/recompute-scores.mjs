// Recompute customer_scores — RFM + churn + LTV + next-order (PRD-02 §F3).
//
//   npm run score                          # score every customer + full report
//   npm run score -- --customer <uuid>     # spot-check one customer
//   npm run score -- --customer <email>    # ...or look them up by email/phone
//   npm run score -- --quiet               # write, print only the summary line
//
// (or directly: node --import tsx scripts/recompute-scores.mjs [flags])
//
// The scoring itself lives in db/scoring.sql — one INSERT ... ON CONFLICT DO
// UPDATE. This file is the runner and the evidence: it executes that SQL and
// then reads the result back out of Postgres and prints what actually landed,
// including a falsification test of the product's central claim.
//
// WHAT THIS SCRIPT IS TRYING TO PROVE
// -----------------------------------
// PRD-02 §F3.2 says churn is measured against each customer's OWN median
// inter-purchase gap. That claim is only worth making if it is falsifiable, so
// the report below runs the falsification: it searches EVERY possible global
// "silent for N days" threshold and reports the best one any spreadsheet could
// pick, and how many customers it still gets wrong. If some threshold
// reproduced the At Risk set exactly, the thesis would be decoration and this
// script would say so.
//
// TIME
// ----
// Scoring reads now(), NOT the seed's fixed anchor. An order arriving by
// webhook at 3am has to score against real time; a scoring job that believes
// in a frozen "today" is a demo prop, not a production job. The seed is
// deterministic and cheap to re-run if the dataset ages out from under it.
// db/scoring.sql derives every date in UTC explicitly (`at time zone 'UTC'`)
// rather than trusting the session TimeZone, so "calendar day" means one
// thing no matter which pooled connection runs it — which is what makes two
// runs minutes apart produce identical scores.
//
// MONEY
// -----
// Every rupee figure is computed and formatted inside Postgres in exact
// numeric and arrives here as a string. There is no parseFloat in this file,
// on purpose — numeric(12,2) through a JS double is how money silently drifts.

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Environment — .env.local is owned by the controller; this only reads it.
// Same minimal reader as scripts/seed-supabase.mjs (split on /\r?\n/ so a CRLF
// file does not leave a trailing \r inside the value).
// ---------------------------------------------------------------------------
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { db } = await import('../db/index.ts');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const QUIET = flag('quiet');
const CUSTOMER_ARG = opt('customer', null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rows = async (q) => (await db.execute(q)).rows;

// The seed's six generator cohorts (PRD-01 §5.3) are NOT the eleven segment_t
// values the product reports; they are how the data was manufactured. Their
// shares are repeated here only so the cross-tab below can be read against
// them — this script never writes them anywhere.
const COHORT_SHARE = {
  champions: 0.12, loyal: 0.18, promising: 0.15,
  at_risk: 0.2, hibernating: 0.2, one_and_done: 0.15,
};
const CHAMPION_AOV = 2000; // rupees; CHAMPION_AOV_PAISE / 100 in the seed

const SEGMENTS = [
  'champions', 'loyal', 'potential_loyalist', 'new_customer', 'promising',
  'need_attention', 'about_to_sleep', 'at_risk', 'cant_lose_them',
  'hibernating', 'lost',
];

function table(headers, body) {
  const all = [headers, ...body.map((r) => r.map(String))];
  const w = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => '  ' + r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(headers), '  ' + w.map((n) => '─'.repeat(n)).join('  '), ...body.map((r) => line(r.map(String)))].join('\n');
}

const rule = (t) => `\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`;

// ---------------------------------------------------------------------------
// Resolve --customer to a uuid (accepts uuid, email or E.164 phone).
// ---------------------------------------------------------------------------
let targetId = null;
if (CUSTOMER_ARG) {
  if (UUID_RE.test(CUSTOMER_ARG)) {
    targetId = CUSTOMER_ARG;
  } else {
    const hit = await rows(sql`
      select id from customers
      where email = ${CUSTOMER_ARG} or phone_e164 = ${CUSTOMER_ARG}
      limit 2
    `);
    if (hit.length !== 1) {
      console.error(`--customer "${CUSTOMER_ARG}" matched ${hit.length} customers; pass a uuid.`);
      process.exit(1);
    }
    targetId = hit[0].id;
  }
}

// ---------------------------------------------------------------------------
// Run the scoring SQL.
// ---------------------------------------------------------------------------
// db/scoring.sql takes $1 (the customer filter). Drizzle's tagged-template
// `sql` builds its own placeholders, so the file is handed to the underlying
// pg pool directly rather than being spliced into a template — splicing a
// uuid into SQL text would be an injection hole for no benefit.
const scoringSql = readFileSync(new URL('../db/scoring.sql', import.meta.url), 'utf8');
const startedAt = Date.now();
const result = await db.$client.query(scoringSql, [targetId]);
const elapsedMs = Date.now() - startedAt;

const { now_ts, today } = (await rows(sql`select now() as now_ts, (now() at time zone 'UTC')::date as today`))[0];
console.log(
  `Scored ${result.rowCount} customer${result.rowCount === 1 ? '' : 's'} in ${elapsedMs}ms ` +
  `against now() = ${now_ts} (UTC)` + (targetId ? ` [--customer ${targetId}]` : ''),
);

// ---------------------------------------------------------------------------
// Spot check: one customer, everything about them.
// ---------------------------------------------------------------------------
if (targetId) {
  const [r] = await rows(sql`
    select c.first_name || ' ' || c.last_name as name, c.email,
           s.rfm_r, s.rfm_f, s.rfm_m, s.segment, s.churn_risk, s.churn_reason,
           s.predicted_ltv, s.ltv_reason, s.next_order_date, s.next_order_reason,
           s.median_interval_days, s.days_since_last_order, s.order_count,
           s.lifetime_value, s.aov, s.computed_at
    from customer_scores s join customers c on c.id = s.customer_id
    where s.customer_id = ${targetId}
  `);
  if (!r) {
    console.error('No score row written — does that customer exist?');
    process.exit(1);
  }
  console.log(rule(`${r.name}  <${r.email}>`));
  console.log(`  RFM              ${r.rfm_r}/${r.rfm_f}/${r.rfm_m}   segment: ${r.segment}`);
  console.log(`  Orders           ${r.order_count}, LTV ₹${r.lifetime_value}, AOV ₹${r.aov}`);
  console.log(`  Cadence          median ${r.median_interval_days ?? 'n/a'} days, silent ${r.days_since_last_order} days`);
  console.log(`\n  Churn ${r.churn_risk}/100`);
  console.log(`    ${r.churn_reason}`);
  console.log(`\n  Predicted LTV ₹${r.predicted_ltv}`);
  console.log(`    ${r.ltv_reason}`);
  console.log(`\n  Next order ${r.next_order_date}`);
  console.log(`    ${r.next_order_reason}`);
  console.log(`\n  computed_at ${r.computed_at}`);
  process.exit(0);
}

if (QUIET) process.exit(0);

// ---------------------------------------------------------------------------
// 1. Segment distribution across all 11 segment_t values.
// ---------------------------------------------------------------------------
const segRows = await rows(sql`
  select segment::text as segment, count(*)::int as n,
         round(avg(churn_risk))::int as avg_churn,
         min(days_since_last_order) as min_silent,
         max(days_since_last_order) as max_silent,
         round(avg(median_interval_days), 1) as avg_gap
  from customer_scores group by 1
`);
const total = segRows.reduce((a, r) => a + r.n, 0);
const bySeg = new Map(segRows.map((r) => [r.segment, r]));

console.log(rule('SEGMENT DISTRIBUTION (all 11 segment_t values)'));
console.log(table(
  ['Segment', 'n', '%', 'avg churn', 'silent min', 'silent max', 'avg own gap'],
  SEGMENTS.map((s) => {
    const r = bySeg.get(s);
    return r
      ? [s, r.n, `${((r.n / total) * 100).toFixed(1)}%`, r.avg_churn, r.min_silent, r.max_silent, r.avg_gap ?? '—']
      : [s, 0, '0.0%', '—', '—', '—', '—'];
  }),
));

// ---------------------------------------------------------------------------
// 2. Cross-tab against the seed's six generator cohorts.
//    The classifier below is the seed's classify() translated to SQL, run
//    against now() rather than the seed's frozen anchor.
// ---------------------------------------------------------------------------
const cohortSql = sql`
  with g as (
    select customer_id, processed_at, total,
           extract(epoch from (processed_at - lag(processed_at)
             over (partition by customer_id order by processed_at))) / 86400 as gap_days
    from orders where customer_id is not null
  ),
  pc as (
    select customer_id, count(*)::int n, max(processed_at) last_at,
           sum(total) / count(*) aov,
           percentile_cont(0.5) within group (order by gap_days)
             filter (where gap_days is not null) as median_gap
    from g group by 1
  ),
  s as (select *, extract(epoch from (now() - last_at)) / 86400 as last_days from pc)
  select customer_id, case
    when n = 1 then case when last_days >= 90 then 'one_and_done' else 'other' end
    when last_days >= 180 then 'hibernating'
    when n >= 3 and median_gap is not null and last_days >= 2 * median_gap then 'at_risk'
    when n >= 5 and last_days < 30 and aov >= ${CHAMPION_AOV} then 'champions'
    when n >= 3 and last_days < 90 then 'loyal'
    when n = 2 and last_days < 90 then 'promising'
    else 'other' end as cohort
  from s
`;

const crossRows = await rows(sql`
  with cohorts as (${cohortSql})
  select co.cohort, cs.segment::text as segment, count(*)::int as n
  from cohorts co join customer_scores cs on cs.customer_id = co.customer_id
  group by 1, 2
`);

const cohortKeys = [...Object.keys(COHORT_SHARE), 'other'];
const cohortTotals = new Map();
for (const r of crossRows) cohortTotals.set(r.cohort, (cohortTotals.get(r.cohort) ?? 0) + r.n);

console.log(rule('SEED COHORT  ->  PRODUCT SEGMENT  (rows: 6 generator cohorts, cols: segment_t)'));
console.log(table(
  ['Cohort', 'n', 'target', ...SEGMENTS.map((s) => s.slice(0, 9))],
  cohortKeys
    .filter((k) => cohortTotals.has(k))
    .map((k) => [
      k,
      cohortTotals.get(k) ?? 0,
      COHORT_SHARE[k] ? Math.round(COHORT_SHARE[k] * total) : '—',
      ...SEGMENTS.map((s) => crossRows.find((r) => r.cohort === k && r.segment === s)?.n ?? '·'),
    ]),
));

// ---------------------------------------------------------------------------
// 3. Churn score distribution.
// ---------------------------------------------------------------------------
const churnRows = await rows(sql`
  select width_bucket(churn_risk, 0, 100, 10) as b,
         count(*)::int as n,
         min(churn_risk) as lo, max(churn_risk) as hi,
         min(days_since_last_order) as min_silent,
         max(days_since_last_order) as max_silent
  from customer_scores group by 1 order by 1
`);
const churnStats = (await rows(sql`
  select round(avg(churn_risk), 1) as mean,
         percentile_cont(0.5) within group (order by churn_risk) as p50,
         percentile_cont(0.9) within group (order by churn_risk) as p90,
         min(churn_risk) as lo, max(churn_risk) as hi,
         count(*) filter (where churn_risk >= 65)::int as high
  from customer_scores
`))[0];

console.log(rule('CHURN RISK DISTRIBUTION'));
console.log(table(
  ['Band', 'n', '%', 'bar', 'silent min', 'silent max'],
  churnRows.map((r) => {
    const lo = (r.b - 1) * 10;
    return [
      `${lo}-${Math.min(lo + 9, 100)}`,
      r.n,
      `${((r.n / total) * 100).toFixed(1)}%`,
      '█'.repeat(Math.max(1, Math.round((r.n / total) * 120))),
      r.min_silent,
      r.max_silent,
    ];
  }),
));
console.log(`\n  mean ${churnStats.mean}  p50 ${churnStats.p50}  p90 ${churnStats.p90}  ` +
            `range ${churnStats.lo}–${churnStats.hi}  ·  ${churnStats.high} customers at ≥65`);

// ---------------------------------------------------------------------------
// 4. FALSIFICATION — how much does the personal cadence actually change?
//
// AN EARLIER VERSION OF THIS TEST COULD NOT FAIL, and said so in a way that
// flattered the result. It swept only one-sided rules ("silent >= N") against
// a MIDDLE-BAND label (segment = 'at_risk', which sits between the healthy
// segments and the lost ones). A one-sided rule structurally cannot fit a
// middle band, so the test was guaranteed to "prove" the thesis no matter
// what the data said. It reported 307/800 wrong. The honest figure is far
// smaller. A test that cannot fail is worse than no test, because it
// launders a weak result as a strong one.
//
// This version fixes three things:
//   · it evaluates against `churn_risk >= HIGH_CHURN`, which is the thesis's
//     actual output, not a middle-band segment label;
//   · it sweeps TWO-SIDED bands [lo, hi] as well as one-sided rules, so a
//     middle band is reachable by the competing rule;
//   · it reports whichever number falls out, flattering or not.
//
// The band sweep is exact, not sampled. For a band [lo,hi]:
//     errors = P - (P<=hi - P<lo) + (N<=hi - N<lo)
// evaluated over every pair of distinct day values.
// ---------------------------------------------------------------------------
const HIGH_CHURN = 65; // the promote threshold, i.e. "this customer is a risk"

// labelSql: a boolean SQL expression over customer_scores.
async function sweep(labelSql) {
  const cte = sql`
    with base as (
      select days_since_last_order as dd, (case when ${labelSql} then 1 else 0 end) as pos
      from customer_scores where days_since_last_order is not null
    ),
    agg as (select dd, sum(pos)::int as p, (count(*) - sum(pos))::int as n from base group by dd),
    cum as (
      select dd, p, n,
             sum(p) over (order by dd)::int as p_le,
             sum(n) over (order by dd)::int as n_le,
             (sum(p) over (order by dd) - p)::int as p_lt,
             (sum(n) over (order by dd) - n)::int as n_lt
      from agg
    ),
    tot as (select sum(p)::int as pos_total from agg),
    bands as (
      select a.dd as lo, b.dd as hi, t.pos_total,
             (t.pos_total - (b.p_le - a.p_lt))::int as missed,
             (b.n_le - a.n_lt)::int                 as false_alarm
      from cum a join cum b on b.dd >= a.dd cross join tot t
    ),
    scored_bands as (
      select *, missed + false_alarm as errors, (select max(dd) from cum) as top from bands
    )
  `;
  const [twoSided] = await rows(sql`${cte}
    select lo, hi, missed, false_alarm, errors, pos_total
    from scored_bands order by errors asc, lo asc, hi desc limit 1`);
  const [oneSided] = await rows(sql`${cte}
    select lo, hi, missed, false_alarm, errors, pos_total
    from scored_bands where hi = top order by errors asc, lo asc limit 1`);
  return { twoSided, oneSided };
}

const vsChurn = await sweep(sql`churn_risk >= ${HIGH_CHURN}`);
const vsSegment = await sweep(sql`segment = 'at_risk'`);

const [corr] = await rows(sql`
  select round(corr(churn_risk, days_since_last_order)::numeric, 3) as corr_days,
         round(corr(churn_risk, days_since_last_order / median_interval_days)::numeric, 3) as corr_overdue,
         count(*)::int as n
  from customer_scores where median_interval_days is not null
`);
const [gaps] = await rows(sql`
  select round(percentile_cont(0.10) within group (order by median_interval_days)::numeric, 1) as p10,
         round(percentile_cont(0.50) within group (order by median_interval_days)::numeric, 1) as p50,
         round(percentile_cont(0.90) within group (order by median_interval_days)::numeric, 1) as p90,
         min(median_interval_days) as mn, max(median_interval_days) as mx
  from customer_scores
`);

console.log(rule('FALSIFICATION TEST — how much does the personal cadence change?'));
const reportSweep = (title, res) => {
  console.log(`\n  Target: ${title}  (${res.oneSided.pos_total} customers)`);
  const line = (name, b, ruleText) => {
    console.log(`    ${name.padEnd(21)} ${ruleText.padEnd(26)} ` +
      `misses ${String(b.missed).padStart(3)}  false alarms ${String(b.false_alarm).padStart(3)}  ` +
      `WRONG ${String(b.errors).padStart(3)} (${((b.errors / total) * 100).toFixed(1)}%)`);
  };
  line('best one-sided rule', res.oneSided, `silent >= ${res.oneSided.lo} days`);
  line('best two-sided band', res.twoSided, `silent in [${res.twoSided.lo}, ${res.twoSided.hi}]`);
};
reportSweep(`churn_risk >= ${HIGH_CHURN}  — the thesis's own output`, vsChurn);
reportSweep(`segment = 'at_risk'  — a middle band, shown for completeness`, vsSegment);

const verdict = vsChurn.oneSided.errors <= vsChurn.twoSided.errors ? vsChurn.oneSided : vsChurn.twoSided;
const verdictPct = ((verdict.errors / total) * 100).toFixed(1);
console.log(`\n  Correlation with churn_risk:  days silent ${corr.corr_days}   vs   overdue ratio ${corr.corr_overdue}   (n=${corr.n})`);
console.log(`  Personal gap spread:          min ${gaps.mn}  p10 ${gaps.p10}  p50 ${gaps.p50}  p90 ${gaps.p90}  max ${gaps.mx} days`);
console.log(`\n  HONEST RESULT: the best global day-rule reproduces the high-churn set to`);
console.log(`  within ${verdict.errors} customers (${verdictPct}% of the base). Cadence changes the verdict for`);
console.log(`  those ${verdict.errors}, and for nobody else.`);
console.log(`\n  That margin is modest, and it is a property of THIS DATASET rather than of`);
console.log(`  the method: personal gaps here cluster tightly (p10 ${gaps.p10}d, p50 ${gaps.p50}d, p90 ${gaps.p90}d),`);
console.log(`  so calendar silence and overdue-ratio rank customers similarly. A catalogue`);
console.log(`  mixing 14-day consumables with 6-month durables would separate them far more.`);
console.log(`  The claim this test supports is "cadence beats the best calendar rule for`);
console.log(`  ${verdict.errors} of 800 customers here", NOT "a calendar cannot do this".`);

// Two customers at the same silence, opposite verdicts — the demo slide.
const contrast = await rows(sql`
  with pairs as (
    select a.customer_id a_id, b.customer_id b_id, a.days_since_last_order d,
           a.median_interval_days a_gap, b.median_interval_days b_gap,
           a.churn_risk a_risk, b.churn_risk b_risk
    from customer_scores a join customer_scores b
      on b.days_since_last_order = a.days_since_last_order
    where a.churn_risk - b.churn_risk >= 40
      and a.order_count >= 3 and b.order_count >= 3
  )
  select * from pairs order by (a_risk - b_risk) desc, d desc limit 3
`);
if (contrast.length) {
  console.log('\n  Same silence, opposite verdict — real rows, but these are the extremes.');
  console.log('  Judge the method by the aggregate above, not by these three:');
  for (const p of contrast) {
    console.log(`    ${String(p.d).padStart(3)} days silent →  churn ${String(p.a_risk).padStart(3)} (own gap ${p.a_gap}d)   vs   churn ${String(p.b_risk).padStart(3)} (own gap ${p.b_gap}d)`);
  }
}

// ---------------------------------------------------------------------------
// 4b. OVERRIDE AUDIT — what each cadence-override branch actually did.
//
// The CTE chain is lifted verbatim out of db/scoring.sql (everything before
// the INSERT) and given a different SELECT, so this counts the real branches
// rather than a re-implementation that could drift from them. Claims about
// the overrides are now checked by the job on every run, because the previous
// report claimed both directions fired when only one did.
// ---------------------------------------------------------------------------
const cteChain = scoringSql.split('insert into customer_scores')[0];
const moves = (await db.$client.query(cteChain + `
  select grid_segment, segment::text as segment, count(*)::int as n,
         min(churn_risk) as min_churn, max(churn_risk) as max_churn
  from computed
  where grid_segment <> segment::text
  group by 1, 2 order by 3 desc, 1, 2
`)).rows;
const RISK_SEGS = new Set(['at_risk', 'cant_lose_them', 'hibernating', 'lost']);
const promoted = moves.filter((m) => !RISK_SEGS.has(m.grid_segment) && RISK_SEGS.has(m.segment));
const rescued = moves.filter((m) => RISK_SEGS.has(m.grid_segment) && !RISK_SEGS.has(m.segment));
const sumN = (a) => a.reduce((t, m) => t + m.n, 0);

console.log(rule('OVERRIDE AUDIT — what the cadence override actually moved'));
console.log(table(
  ['grid segment', 'final segment', 'n', 'churn lo', 'churn hi'],
  moves.map((m) => [m.grid_segment, m.segment, m.n, m.min_churn, m.max_churn]),
));
console.log(`\n  PROMOTE (healthy grid cell -> a risk segment):  ${sumN(promoted)} customers`);
console.log(`  RESCUE  (risk grid cell -> a healthy segment):  ${sumN(rescued)} customers`);
console.log(`  severity reclassification within the risk set:  ${sumN(moves) - sumN(promoted) - sumN(rescued)} customers`);
if (sumN(rescued) === 0) {
  console.log(`\n  NOTE: the rescue branch moved NOBODY out of at_risk/hibernating/lost. The`);
  console.log(`  grid only reaches at_risk at R<=2 (>=116 days silent here) and the longest`);
  console.log(`  personal gap in this data is ${gaps.mx} days, so no grid-at_risk customer can`);
  console.log(`  score below ~30 churn. That is a seed property, not a vindication of the`);
  console.log(`  branch — do not claim it is doing work on this dataset.`);
}

// ---------------------------------------------------------------------------
// 5. Sample rows — score next to reason, so the reasons can be judged.
// ---------------------------------------------------------------------------
// One representative per populated segment: the customer sitting closest to
// that segment's mean churn, not its most extreme member. Cherry-picking the
// worst row from every segment would make the reasons look better than they
// are, which defeats the point of printing them.
const samples = await rows(sql`
  select * from (
    select distinct on (s.segment)
      c.first_name || ' ' || c.last_name as name,
      s.segment::text as segment, s.rfm_r, s.rfm_f, s.rfm_m,
      s.order_count, s.churn_risk, s.churn_reason,
      s.predicted_ltv, s.ltv_reason,
      s.next_order_date, s.next_order_reason
    from (
      select cs.*, avg(churn_risk) over (partition by segment) as seg_avg
      from customer_scores cs
    ) s
    join customers c on c.id = s.customer_id
    order by s.segment, abs(s.churn_risk - s.seg_avg), s.customer_id
  ) t order by churn_risk asc
`);

console.log(rule('EXAMPLE ROWS — every score with the reason it wrote'));
for (const r of samples) {
  console.log(`\n  ${r.name}  ·  ${r.segment}  ·  RFM ${r.rfm_r}/${r.rfm_f}/${r.rfm_m}`);
  console.log(`    churn ${r.churn_risk}/100      ${r.churn_reason}`);
  console.log(`    LTV ₹${r.predicted_ltv}       ${r.ltv_reason}`);
  console.log(`    next ${r.next_order_date}   ${r.next_order_reason}`);
}

// ---------------------------------------------------------------------------
// 5b. NEXT ORDER DATE — the prediction, and whether it is actually predicting.
//
// This column used to be clamped forward (`greatest(due_date, today)`), which
// parked 594 of 800 customers on the scoring run's own date. Two symptoms, and
// this section exists so neither can come back silently:
//
//   · CONCENTRATION. A forecast should spread across the calendar. If any
//     single date holds a large share of the base, the column is reporting
//     when the job last ran, not when anyone will buy.
//   · STABILITY. `next_order_date < current_date` is the agent's own overdue
//     idiom (few-shot #8). Under the clamp that count only looked right while
//     the scores were stale, and collapsed the moment anyone re-scored — so a
//     demo-day rescore broke the demo. It must now be invariant to re-running.
// ---------------------------------------------------------------------------
const [dateShape] = await rows(sql`
  select count(*)::int                                              as with_date,
         count(distinct next_order_date)::int                       as distinct_dates,
         min(next_order_date)                                       as earliest,
         max(next_order_date)                                       as latest,
         count(*) filter (where next_order_date < current_date)::int as overdue,
         count(*) filter (where next_order_date = current_date)::int as on_today
  from customer_scores where next_order_date is not null
`);
const topDates = await rows(sql`
  select next_order_date::text as d, count(*)::int as n
  from customer_scores where next_order_date is not null
  group by 1 order by 2 desc, 1 limit 5
`);
const spread = await rows(sql`
  select case when next_order_date < current_date - 180 then 'more than 180d ago'
              when next_order_date < current_date - 30  then '30-180d ago'
              when next_order_date < current_date       then 'under 30d ago'
              when next_order_date = current_date       then 'today'
              when next_order_date <= current_date + 30 then 'within 30d'
              else 'more than 30d out' end as bucket,
         count(*)::int as n, min(next_order_date) as lo, max(next_order_date) as hi
  from customer_scores where next_order_date is not null
  group by 1 order by min(next_order_date)
`);

console.log(rule('NEXT ORDER DATE — distribution of the prediction'));
console.log(table(
  ['When it falls', 'n', '%', 'earliest', 'latest'],
  spread.map((r) => [r.bucket, r.n, `${((r.n / dateShape.with_date) * 100).toFixed(1)}%`, r.lo, r.hi]),
));
console.log(`\n  ${dateShape.with_date} customers with a predicted date, ` +
            `${dateShape.distinct_dates} distinct values, spanning ${dateShape.earliest} to ${dateShape.latest}`);
console.log(`  overdue (next_order_date < current_date): ${dateShape.overdue}   ` +
            `landing exactly on today: ${dateShape.on_today}`);
console.log('\n  Most common single dates (a spike here means the column is reporting the run date):');
for (const d of topDates) {
  console.log(`    ${d.d}   ${String(d.n).padStart(3)}  (${((d.n / dateShape.with_date) * 100).toFixed(1)}%)`);
}
const worstShare = topDates.length ? topDates[0].n / dateShape.with_date : 0;
console.log(
  worstShare > 0.05
    ? `\n  ✗ ${(worstShare * 100).toFixed(1)}% of customers share one date — this column is NOT a forecast.`
    : `\n  ✓ No single date holds more than ${(worstShare * 100).toFixed(1)}% of the base — the column forecasts.`,
);

// Do the date and its own reason agree? §F3.6 is worthless if they disagree.
const [agree] = await rows(sql`
  select count(*)::int as checked,
         count(*) filter (where
           (next_order_date <  current_date and next_order_reason like 'Was due%') or
           (next_order_date >= current_date and next_order_reason like 'Last ordered%')
         )::int as consistent
  from customer_scores where next_order_date is not null
`);
console.log(`  date vs next_order_reason agree: ${agree.consistent} of ${agree.checked}` +
            (agree.consistent === agree.checked ? '  ✓' : '  ✗ MISMATCH'));

// ---------------------------------------------------------------------------
// 6. Integrity + idempotency fingerprint.
//
// Every score column except computed_at, hashed in customer_id order. Two runs
// that print the same fingerprint wrote identical scores; computed_at is
// excluded on purpose because it is *supposed* to move.
// ---------------------------------------------------------------------------
const [audit] = await rows(sql`
  select
    (select count(*)::int from customers) as customers,
    count(*)::int as scored,
    count(*) filter (where churn_reason is null or churn_reason = '')::int as missing_churn_reason,
    count(*) filter (where ltv_reason is null or ltv_reason = '')::int as missing_ltv_reason,
    count(*) filter (where next_order_reason is null or next_order_reason = '')::int as missing_next_reason,
    count(*) filter (where segment is null)::int as missing_segment,
    count(*) filter (where churn_risk is null)::int as missing_churn,
    count(*) filter (where churn_risk not between 0 and 100)::int as churn_out_of_range,
    count(distinct segment)::int as distinct_segments
  from customer_scores
`);
const [fp] = await rows(sql`
  select md5(string_agg(row, '|' order by row)) as fingerprint from (
    select customer_id::text || ':' || coalesce(rfm_r::text,'-') || coalesce(rfm_f::text,'-')
           || coalesce(rfm_m::text,'-') || ':' || coalesce(segment::text,'-') || ':'
           || coalesce(churn_risk::text,'-') || ':' || coalesce(predicted_ltv::text,'-') || ':'
           || coalesce(next_order_date::text,'-') || ':' || coalesce(churn_reason,'-') || ':'
           || coalesce(ltv_reason,'-') || ':' || coalesce(next_order_reason,'-') as row
    from customer_scores
  ) t
`);

console.log(rule('INTEGRITY'));
console.log(table(
  ['Check', 'Value'],
  [
    ['customers', audit.customers],
    ['rows in customer_scores', audit.scored],
    ['distinct segments used', `${audit.distinct_segments} of 11`],
    ['missing churn_reason', audit.missing_churn_reason],
    ['missing ltv_reason', audit.missing_ltv_reason],
    ['missing next_order_reason', audit.missing_next_reason],
    ['missing segment', audit.missing_segment],
    ['missing churn_risk', audit.missing_churn],
    ['churn_risk out of 0–100', audit.churn_out_of_range],
  ],
));

const problems = [];
if (audit.scored !== audit.customers) problems.push(`${audit.customers - audit.scored} customers have no score row`);
for (const k of ['missing_churn_reason', 'missing_ltv_reason', 'missing_next_reason', 'missing_segment', 'missing_churn', 'churn_out_of_range']) {
  if (audit[k] > 0) problems.push(`${audit[k]} rows: ${k}`);
}

console.log(`\n  score fingerprint (excludes computed_at): ${fp.fingerprint}`);
console.log('  Re-run this script; an identical fingerprint proves the job is idempotent.');

if (problems.length) {
  console.error('\n✗ ' + problems.join('\n✗ '));
  process.exit(1);
}
console.log(`\n✓ ${audit.scored} customers scored, every score carries its reason (§F3.6), today ${today}`);
process.exit(0);
