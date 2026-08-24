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
// 4. FALSIFICATION — can any global day-threshold reproduce the At Risk set?
//
// Sweeps every candidate cutoff over days_since_last_order and finds the one
// that best reproduces segment = 'at_risk'. If the best possible global rule
// still misclassifies a meaningful share of customers, then this segmentation
// is not a day-threshold in disguise, which is the entire product claim.
// ---------------------------------------------------------------------------
const [overlap] = await rows(sql`
  with a as (select days_since_last_order d from customer_scores where segment = 'at_risk'),
       b as (select days_since_last_order d from customer_scores where segment <> 'at_risk')
  select (select min(d) from a) as ar_min,
         (select max(d) from a) as ar_max,
         (select count(*)::int from b where d >= (select min(d) from a)) as non_ar_silent_longer_than_least_silent_ar,
         (select round(avg(median_interval_days), 1) from customer_scores where segment = 'at_risk') as ar_avg_gap,
         (select round(avg(median_interval_days), 1) from customer_scores where segment <> 'at_risk') as other_avg_gap
`);

const errsCte = sql`
  with cand as (select distinct days_since_last_order as thr from customer_scores where days_since_last_order is not null),
  errs as (
    select c.thr,
      (select count(*)::int from customer_scores s
        where s.segment = 'at_risk' and s.days_since_last_order < c.thr) as missed,
      (select count(*)::int from customer_scores s
        where s.segment <> 'at_risk' and s.days_since_last_order >= c.thr) as false_alarm
    from cand c
  )
`;
const [best] = await rows(sql`${errsCte}
  select thr, missed, false_alarm, missed + false_alarm as errors
  from errs order by errors asc, thr asc limit 1
`);
// The unconstrained optimum can be degenerate — "set the cutoff past everyone
// and flag nobody" is itself a global rule, and if it wins, that is the
// result. So also report the best cutoff that actually flags people, which is
// the rule a spreadsheet user would really write.
const [bestReal] = await rows(sql`${errsCte}
  select thr, missed, false_alarm, missed + false_alarm as errors
  from errs
  where thr <= (select max(days_since_last_order) from customer_scores where segment = 'at_risk')
  order by errors asc, thr asc limit 1
`);

const arTotal = bySeg.get('at_risk')?.n ?? 0;
console.log(rule('FALSIFICATION TEST — is this just a global day-threshold?'));
console.log(`  At Risk customers:                        ${arTotal}`);
console.log(`  Their days-silent range:                  ${overlap.ar_min}–${overlap.ar_max} days`);
console.log(`  NOT At Risk yet silent ≥ ${String(overlap.ar_min).padStart(3)} days:        ${overlap.non_ar_silent_longer_than_least_silent_ar}`);
console.log(`  Mean own-gap, At Risk vs everyone else:   ${overlap.ar_avg_gap} vs ${overlap.other_avg_gap} days`);
const cutoff = (label, b) => {
  console.log(`\n  ${label}: "silent ≥ ${b.thr} days"`);
  console.log(`    misses  ${b.missed} of ${arTotal} real At Risk customers (${((b.missed / Math.max(1, arTotal)) * 100).toFixed(0)}%)`);
  console.log(`    flags   ${b.false_alarm} customers who are NOT At Risk`);
  console.log(`    total   ${b.errors} customers wrong (${((b.errors / total) * 100).toFixed(1)}% of the base)`);
};
cutoff('Best global cutoff of any kind', best);
if (bestReal && bestReal.thr !== best.thr) {
  cutoff('Best cutoff that actually flags someone', bestReal);
}
console.log(
  best.errors > 0
    ? `\n  ✓ No global silence threshold reproduces this At Risk set. The segmentation\n` +
      `    is driven by each customer's own median gap, exactly as PRD-02 §F3.2 claims.`
    : `\n  ✗ A single global threshold reproduces the At Risk set exactly. The cadence\n` +
      `    thesis is NOT implemented — this is a spreadsheet with extra steps.`,
);

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
  console.log('\n  Same silence, opposite verdict:');
  for (const p of contrast) {
    console.log(`    ${String(p.d).padStart(3)} days silent →  churn ${String(p.a_risk).padStart(3)} (own gap ${p.a_gap}d)   vs   churn ${String(p.b_risk).padStart(3)} (own gap ${p.b_gap}d)`);
  }
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
