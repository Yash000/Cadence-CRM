-- =========================================================================
-- Cadence CRM — RFM + predictive scoring (PRD-02 §F3.1–F3.4, §F3.6)
--
-- Run by scripts/recompute-scores.mjs. One statement: a single INSERT ...
-- ON CONFLICT DO UPDATE over customer_scores, fed by a CTE chain. Re-running
-- it recomputes every row in place — no deletes, no duplicates, no schema
-- changes (customer_scores already exists; this file must never DDL).
--
-- Parameters
--   $1 :: uuid  — NULL to score every customer, or one customer id to score
--                 just that customer (the --customer spot-check flag).
--
--                 The RFM quintiles and the store-wide fallbacks below are
--                 ALWAYS computed over the whole customer base; $1 filters
--                 only the final INSERT. Scoring one customer must produce
--                 the same row a full run would, otherwise a spot check is
--                 measuring the spot check.
--
-- WHY THIS IS SHAPED THE WAY IT IS
-- --------------------------------
-- 1. CADENCE, NOT A CALENDAR. §F3.2 is the product thesis: churn risk is
--    measured against each customer's OWN median inter-purchase gap. Every
--    predictive column here divides by `cadence_days`, which is that
--    customer's personal median gap — never a global constant. 90 days of
--    silence is 0.97x for a 93-day-gap customer and 6.0x for a 15-day-gap
--    customer, and they get wildly different scores. If any number below
--    could be reproduced by a global "silent for N days" cutoff, this file
--    would have failed at its only job.
--
-- 1b. TWO TIERS, ONE CURVE. Furniture does not deplete, so `cadence_days`
--    does not mean the same thing for every customer, and the catalogue says
--    which meaning applies (data/catalogue.json):
--
--      ROOM tier  (living-room / bedroom / dining) — the cadence is an
--        ATTACH WINDOW. A sofa opens a room project; the coffee table, rug
--        and lamp follow within weeks. Being "overdue" means the room
--        stalled with the window closed, which is a cross-sell that is
--        slipping away — not a customer who forgot to reorder.
--
--      CARE tier  (care-decor) — cushion covers, throws, vases, polish and
--        fabric guard genuinely do get rebought. The cadence is an ordinary
--        replenishment cycle and means exactly what it meant before.
--
--    The piecewise curve, the RFM grid and the three-layer segment logic are
--    IDENTICAL across both tiers and are deliberately left untouched. Only
--    three things are tier-aware: which store-median a single-order customer
--    borrows (per-tier, because one blended median across a ₹649 polish and
--    a ₹92,000 bed is a number describing nobody), how long absolute silence
--    must run before `lost`/`hibernating` fire, and what the reason strings
--    say. A finished living room going quiet for eight months is normal; a
--    fabric guard eight months late is not.
--
-- 2. MONEY STAYS IN POSTGRES `numeric`. Money columns are numeric(12,2) and
--    the JS driver hands them back as strings precisely so nobody
--    parseFloat()s them. All money arithmetic happens here, in exact
--    decimal numeric, and crosses the wire only as a formatted string. The
--    only JS-side numbers are counts and day integers.
--
-- 3. WHOLE-DAY RECENCY. days_since_last_order is a calendar-day difference,
--    not a fractional epoch delta. That makes two runs an hour apart produce
--    byte-identical scores (idempotency), and it matches what the reason
--    string claims ("last 142 days ago"). Every date is derived in UTC
--    explicitly, so "calendar day" means one thing regardless of which
--    pooled connection runs the job.
--
-- 4. EVERY SCORE CARRIES ITS REASON (§F3.6, non-negotiable). churn_reason,
--    ltv_reason and next_order_reason are built from the same expressions
--    that produced the score, so a reason cannot drift away from its number.
--    Each one names the actual inputs: order count, days silent, that
--    customer's own gap, the multiple. "High churn risk" is not a reason.
-- =========================================================================

with params as (
  select
    now()                            as now_ts,
    -- Every date below is derived in UTC explicitly rather than relying on the
    -- session TimeZone. A scoring job whose "today" depends on whatever
    -- timezone the connection happened to inherit is a job that scores
    -- differently from the pooler than from psql.
    (now() at time zone 'UTC')::date as today,
    -- Gross margin assumption for §F3.3. Own-manufacture furniture retail at
    -- HomeStyle's price points; a single named constant so the assumption is
    -- arguable rather than buried in an expression.
    0.45::numeric        as margin,
    365::numeric         as horizon_days,
    -- Ceiling on predicted future orders. A 15-day-gap customer mathematically
    -- projects to 24 orders/year; claiming that as LTV is how heuristic models
    -- produce nonsense headline numbers.
    12::numeric          as max_future_orders
),

-- Revenue-bearing orders only. Cancelled and refunded orders are not
-- purchases and must not create phantom cadence.
paid_orders as (
  select o.id, o.customer_id, o.processed_at, o.total
  from orders o
  where o.customer_id is not null
    and o.cancelled_at is null
    and o.financial_status in ('paid', 'partially_refunded', 'authorized')
),

gapped as (
  select
    customer_id,
    processed_at,
    total,
    extract(epoch from (processed_at - lag(processed_at)
      over (partition by customer_id order by processed_at))) / 86400.0 as gap_days
  from paid_orders
),

-- Per-customer facts. `median_gap` is THE number this whole product turns on.
-- percentile_cont(0.5) interpolates on even counts, matching the seed's
-- definition of the same statistic.
per_customer as (
  select
    customer_id,
    count(*)::int                                   as order_count,
    max(processed_at)                               as last_at,
    min(processed_at)                               as first_at,
    sum(total)::numeric(12,2)                       as lifetime_value,
    (sum(total) / count(*))::numeric(12,2)          as aov,
    -- percentile_cont returns double precision; cast straight to numeric so
    -- every downstream division is exact decimal and round(x, n) is legal
    -- (there is no two-argument round() for double precision in Postgres).
    round((percentile_cont(0.5) within group (order by gap_days)
      filter (where gap_days is not null))::numeric, 4) as median_gap
  from gapped
  group by customer_id
),

-- The customer's most recent order. Defined here rather than further down
-- because both the tier and the store-wide fallbacks below depend on it.
last_order as (
  select distinct on (customer_id) customer_id, id as order_id, processed_at
  from paid_orders
  order by customer_id, processed_at desc, id
),

-- Which tier the customer's last order belongs to (header note 1b), decided
-- by quantity-weighted majority of the line items. `care-decor` is the only
-- genuinely repeat-purchase collection in the catalogue; the three room
-- collections are projects.
--
-- Ties go to `room`, deliberately: a basket of one rug and one cushion cover
-- is somebody furnishing a room who added a cushion, not somebody restocking
-- cushions who added a rug. The anchor piece is what the outreach is about.
last_tier as (
  select
    lo.customer_id,
    case
      when coalesce(sum(oi.qty) filter (where p.collection =  'care-decor'), 0)
         > coalesce(sum(oi.qty) filter (where p.collection <> 'care-decor'), 0)
      then 'care' else 'room'
    end as tier
  from last_order lo
  join order_items oi on oi.order_id = lo.order_id
  join products p     on p.id = oi.product_id
  group by lo.customer_id
),

per_customer_t as (
  select pc.*, coalesce(lt.tier, 'room') as tier
  from per_customer pc
  left join last_tier lt on lt.customer_id = pc.customer_id
),

-- Store-wide fallbacks, used ONLY where a personal cadence cannot exist
-- (a customer with a single order has no inter-purchase gap). Where this
-- fallback is used the reason string says so out loud, so a borrowed number
-- is never passed off as a personal one.
--
-- The median is taken PER TIER. A single blend across both tiers would be a
-- number describing nobody: room projects run in weeks-to-months and care
-- refills in months-to-half-years, so the pooled median sits in the empty
-- gap between the two humps and would make every borrower look wrong in the
-- same direction. `store_median_gap` survives as the last-resort fallback for
-- the case where a tier has no multi-order customers at all to learn from.
store as (
  select
    round((percentile_cont(0.5) within group (order by median_gap)
      filter (where median_gap is not null))::numeric, 4)          as store_median_gap,
    round((percentile_cont(0.5) within group (order by median_gap)
      filter (where median_gap is not null and tier = 'room'))::numeric, 4)
                                                                   as store_median_gap_room,
    round((percentile_cont(0.5) within group (order by median_gap)
      filter (where median_gap is not null and tier = 'care'))::numeric, 4)
                                                                   as store_median_gap_care,
    (count(*) filter (where order_count > 1))::numeric
      / nullif(count(*), 0)::numeric                               as repeat_rate
  from per_customer_t
),

-- The cadence implied by what was in the last order (§F3.4). Quantity-
-- weighted: two of a 30-day item outweigh one 60-day item. For the room tier
-- `replenishment_days` is the attach window of the piece, not a refill cycle
-- (header note 1b), and the reason strings below say which one they mean.
replenishment as (
  select
    lo.customer_id,
    sum(p.replenishment_days::numeric * oi.qty) / nullif(sum(oi.qty), 0) as repl_days,
    (array_agg(p.title order by oi.qty desc, p.replenishment_days, p.title))[1] as repl_driver
  from last_order lo
  join order_items oi on oi.order_id = lo.order_id
  join products p     on p.id = oi.product_id and p.replenishment_days is not null
  group by lo.customer_id
),

-- RFM quintiles (§F3.1). NTILE(5) over customers WHO HAVE ORDERS.
--   R: ordered by last_at ascending, so the longest-silent bucket is 1 and
--      the most recent is 5.
--   F / M: ascending too, so 5 is always "best" for all three.
--
-- Every ORDER BY ends in customer_id. NTILE splits tie groups arbitrarily
-- otherwise (order_count has only 10 distinct values across 800 customers),
-- and an arbitrary split would move customers between quintiles on re-runs,
-- breaking idempotency for no reason.
--
-- This is a separate CTE over per_customer, NOT a windowed CASE back in the
-- join against `customers`. An order-less customer nulled out after the fact
-- still consumes an NTILE bucket slot, and with a NULL sort key lands at the
-- top — so the first customer whose only orders are cancelled would silently
-- shift every quintile boundary and inflate R5/M5. Ranking only the rows
-- that have something to rank makes that unrepresentable.
quintiles as (
  select
    customer_id,
    ntile(5) over (order by last_at asc, customer_id)                      as rfm_r,
    ntile(5) over (order by order_count asc, last_at asc, customer_id)     as rfm_f,
    ntile(5) over (order by lifetime_value asc, customer_id)               as rfm_m
  from per_customer
),

rfm as (
  select
    c.id as customer_id,
    c.created_at,
    coalesce(pc.order_count, 0)                          as order_count,
    pc.last_at,
    pc.first_at,
    coalesce(pc.lifetime_value, 0)::numeric(12,2)        as lifetime_value,
    pc.aov,
    pc.median_gap,
    coalesce(pc.tier, 'room')                            as tier,
    r.repl_days,
    r.repl_driver,
    q.rfm_r,
    q.rfm_f,
    q.rfm_m
  from customers c
  left join per_customer_t pc on pc.customer_id = c.id
  left join replenishment  r  on r.customer_id  = c.id
  left join quintiles      q  on q.customer_id  = c.id
),

cadence as (
  select
    rfm.*,
    p.now_ts, p.today, p.margin, p.horizon_days, p.max_future_orders,
    s.store_median_gap,
    -- The fallback this customer would borrow, chosen by their tier.
    coalesce(
      case rfm.tier when 'care' then s.store_median_gap_care
                    else             s.store_median_gap_room end,
      s.store_median_gap
    )                                                                  as tier_median_gap,
    s.repeat_rate,
    -- Whole calendar days since the last order (see header note 3).
    case when rfm.last_at is not null
         then (p.today - (rfm.last_at at time zone 'UTC')::date) end       as days_since,
    (p.today - (rfm.created_at at time zone 'UTC')::date)                 as days_since_signup,
    -- THE denominator. Personal wherever a personal number exists; otherwise
    -- borrowed from this customer's OWN tier, never from the pooled median.
    coalesce(
      rfm.median_gap,
      case rfm.tier when 'care' then s.store_median_gap_care
                    else             s.store_median_gap_room end,
      s.store_median_gap
    )                                                               as cadence_days,
    (rfm.median_gap is null)                                        as cadence_borrowed
  from rfm cross join params p cross join store s
),

-- Churn risk 0–100 (§F3.2), a piecewise curve on `overdue` — days silent
-- divided by the customer's own median gap. The knots are chosen so the
-- bands mean something a human can defend:
--   ≤1.0x  (0–20)   inside their own rhythm
--   1–2x   (20–60)  drifting
--   2–3x   (60–90)  the seed's own definition of At Risk starts at 2x
--   >3x    (90–100) gone quiet by any reading of their history
risk as (
  select
    cadence.*,
    case
      when days_since is null then null
      else round(days_since::numeric / nullif(cadence_days, 0), 2)
    end as overdue
  from cadence
),

scored as (
  select
    risk.*,
    case
      -- No orders at all: there is nothing to be overdue against. Scored on
      -- how long they have been a customer without buying, and capped —
      -- this is a weak signal and must not outrank real evidence.
      when order_count = 0 then
        least(60, greatest(0, round(days_since_signup::numeric / 3)))::int
      else
        least(
          case when cadence_borrowed then 85 else 100 end,
          greatest(0, round(
            case
              when overdue <= 1 then overdue * 20
              when overdue <= 2 then 20 + (overdue - 1) * 40
              when overdue <= 3 then 60 + (overdue - 2) * 30
              else 90 + least(10, (overdue - 3) * 5)
            end
          ))
        )::int
    end as churn_risk
  from risk
),

-- The 11 segment_t values (§F3.1). Two layers:
--
--   (a) the canonical RFM grid on R x FM, where FM = ceil((F+M)/2) — the
--       standard 5x5 map, every one of the 25 cells assigned.
--   (b) a CADENCE OVERRIDE, which is where the personal gap changes the
--       verdict. The R quintile is a global ranking: it sorts customers by
--       calendar silence and knows nothing about whose silence is normal.
--       Two branches, and they are NOT equally busy — the script's OVERRIDE
--       AUDIT counts every move on every run, so this comment can never
--       again outrun the evidence:
--
--         · PROMOTE (the branch that earns its keep here): a customer 2x+
--           past their own gap IS at_risk, however high their recency
--           quintile. A 15-day-gap customer 40 days quiet is a five-alarm
--           fire sitting in R4/R5. ~116 moves on this dataset, and these are
--           substantially the customers a global day-threshold misses.
--
--         · RESCUE: a customer well inside their own gap is NOT
--           at_risk/hibernating/lost, however far down the recency ranking
--           they sit. On THIS dataset it moves 6 customers, all
--           about_to_sleep -> need_attention, and rescues zero from
--           at_risk/hibernating/lost. That is a property of the seed, not of
--           the rule: the grid only reaches at_risk at R<=2, which here means
--           >=116 days silent, and the longest personal gap in the data is
--           93.1 days — so the lowest overdue any grid-at_risk customer can
--           even reach is 1.25x, and the lowest actually present is 2.05x.
--           A real store with a 6-month-cadence product line would exercise
--           it constantly. It is kept because it is correct, not because it
--           is busy, and the audit reports its true (small) count.
segmented as (
  select
    scored.*,
    ceil((rfm_f + rfm_m) / 2.0)::int as rfm_fm
  from scored
),

graded as (
  select
    segmented.*,
    case
      -- `new_customer` is not a grid cell. Someone who has bought exactly once
      -- and recently is a new customer by definition — there is no repeat
      -- behaviour to grade yet, and the R/F/M quintiles have nothing to say
      -- about them that their order count does not already say louder.
      when order_count = 0 then
        case when days_since_signup <= 90 then 'new_customer' else 'lost' end
      when order_count = 1 and days_since <= 90 then 'new_customer'
      when rfm_r = 5 then
        case rfm_fm when 1 then 'promising'
                    when 2 then 'promising'
                    when 3 then 'potential_loyalist'
                    when 4 then 'champions'
                    else        'champions' end
      when rfm_r = 4 then
        case rfm_fm when 1 then 'promising'
                    when 2 then 'promising'
                    when 3 then 'potential_loyalist'
                    when 4 then 'loyal'
                    else        'champions' end
      when rfm_r = 3 then
        case rfm_fm when 1 then 'about_to_sleep'
                    when 2 then 'about_to_sleep'
                    when 3 then 'need_attention'
                    when 4 then 'loyal'
                    else        'loyal' end
      when rfm_r = 2 then
        case rfm_fm when 1 then 'hibernating'
                    when 2 then 'hibernating'
                    when 3 then 'at_risk'
                    when 4 then 'at_risk'
                    else        'cant_lose_them' end
      else
        case rfm_fm when 1 then 'lost'
                    when 2 then 'lost'
                    when 3 then 'at_risk'
                    when 4 then 'at_risk'
                    else        'cant_lose_them' end
    end as grid_segment
  from segmented
),

final as (
  select
    graded.*,
    (case
      -- Dead by any measure: months past their own cadence AND long silent.
      --
      -- The absolute floor is tier-aware (header note 1b). 270 days was
      -- calibrated against a consumable line where nine months of silence is
      -- unambiguous. It is not unambiguous for furniture: somebody who
      -- finished their living room in March is *supposed* to be quiet in
      -- December, and calling them `lost` would bury a perfectly healthy
      -- customer under a win-back campaign they will resent. The room tier
      -- gets 18 months; the care tier keeps the original nine.
      when order_count > 0 and overdue >= 4
           and days_since >= (case when tier = 'care' then 270 else 540 end)
        then case when rfm_m = 5 then 'cant_lose_them' else 'lost' end

      -- Overdue against their OWN gap — promote into the risk segments even
      -- from a healthy-looking recency quintile.
      when order_count >= 2 and churn_risk >= 65
           and grid_segment not in ('at_risk', 'cant_lose_them', 'hibernating', 'lost')
        then case when rfm_m = 5 then 'cant_lose_them'
                  when days_since >= (case when tier = 'care' then 180 else 365 end)
                    then 'hibernating'
                  else 'at_risk' end

      -- Inside their OWN gap — rescue from the risk segments. A long personal
      -- cadence is not lapsing behaviour, and this is exactly the customer a
      -- global day-threshold gets wrong.
      when order_count >= 2 and churn_risk <= 35
           and grid_segment in ('at_risk', 'hibernating', 'lost', 'about_to_sleep')
        then case when rfm_fm >= 4 then 'loyal' else 'need_attention' end

      else grid_segment
    end)::segment_t as segment,

    -- ---------------------------------------------------------------
    -- Predicted future orders over the horizon (§F3.3). Personal cadence
    -- sets the rate; survival discounts it; single-order customers are
    -- additionally discounted by the store's observed repeat rate, because
    -- most of them will simply never come back.
    --
    -- Survival is floored at 5% rather than allowed to reach zero. A churn
    -- score of 100 means "gone by their own cadence", not "provably dead":
    -- win-back campaigns exist and do convert. Letting survival hit 0 makes
    -- predicted LTV ₹0 for exactly the customers worth the most effort —
    -- a Can't-Lose-Them with ₹15,000 of history would show as worthless,
    -- and the number stops being usable for prioritising anything.
    -- ---------------------------------------------------------------
    case
      when order_count = 0 then null
      else round(
        least(
          max_future_orders,
          (horizon_days / nullif(cadence_days, 0))
            * greatest(0.05, 1 - churn_risk::numeric / 100)
            * (case when order_count = 1 then repeat_rate else 1 end)
        ), 2)
    end as expected_orders,

    -- Blended next-order cadence (§F3.4): the customer's own gap weighted
    -- 2:1 against the cadence implied by what they last bought — a refill
    -- cycle in the care tier, an attach window in the room tier. Behaviour
    -- outweighs the catalogue, but the catalogue still votes.
    case
      when median_gap is not null and repl_days is not null
        then round((2 * median_gap + repl_days) / 3)
      when median_gap is not null then round(median_gap)
      when repl_days  is not null then round(repl_days)
      else round(store_median_gap)
    end::int as blended_days
  from graded
),

computed as (
  select
    f.*,
    (aov * expected_orders * margin)::numeric(12,2)          as predicted_ltv,
    ((last_at at time zone 'UTC')::date + blended_days)      as due_date
  from final f
)

insert into customer_scores (
  customer_id, rfm_r, rfm_f, rfm_m, segment,
  churn_risk, churn_reason,
  predicted_ltv, ltv_reason,
  next_order_date, next_order_reason,
  median_interval_days, days_since_last_order,
  order_count, lifetime_value, aov, computed_at
)
select
  customer_id,
  rfm_r, rfm_f, rfm_m,
  segment,
  churn_risk,

  -- ---- churn_reason (§F3.6) -------------------------------------------
  -- Tier decides the vocabulary, never the arithmetic: the same `overdue`
  -- multiple is described as a stalled room project or as a late refill,
  -- because those are the two things it can actually mean (header note 1b).
  case
    when order_count = 0 then
      format('No orders yet — customer for %s days, no purchase rhythm to measure against.',
             days_since_signup)
    when order_count = 1 and tier = 'care' then
      format('1 care order, %s days ago, no repeat yet — no personal cycle, so scored against the %s-day care-tier median (%sx).',
             days_since,
             round(tier_median_gap, 0),
             trim(to_char(overdue, 'FM9990.0')))
    when order_count = 1 then
      format('1 order, %s days ago, no follow-on piece yet — scored against the %s-day room-tier median (%sx). %s',
             days_since,
             round(tier_median_gap, 0),
             trim(to_char(overdue, 'FM9990.0')),
             case when overdue >= 2   then 'The room stalled after its opening piece.'
                  when overdue >= 1   then 'The attach window has closed.'
                  else                     'Still inside the attach window.' end)
    when tier = 'care' then
      format('%s orders, last %s days ago, typical cycle %s days — %sx %s.',
             order_count,
             days_since,
             trim(to_char(median_gap, 'FM9990.0')),
             trim(to_char(overdue, 'FM9990.0')),
             case when overdue >= 1.2 then 'overdue for a refill'
                  when overdue >= 0.8 then 'of their usual cycle, due about now'
                  else 'of their usual cycle, on schedule' end)
    else
      format('%s orders, last %s days ago, typical %s days between pieces — %sx %s.',
             order_count,
             days_since,
             trim(to_char(median_gap, 'FM9990.0')),
             trim(to_char(overdue, 'FM9990.0')),
             case when overdue >= 2   then 'their usual gap; the room has stalled'
                  when overdue >= 1.2 then 'their usual gap; the attach window has closed'
                  when overdue >= 0.8 then 'of their usual gap, the next piece is due about now'
                  else 'of their usual gap, the room is still filling on schedule' end)
  end,

  predicted_ltv,

  -- ---- ltv_reason (§F3.6) ---------------------------------------------
  case
    when order_count = 0 then 'No orders yet — no spend history to project from.'
    when order_count = 1 then
      format('AOV %s x %s expected orders over 12 months (%s-day %s-tier median gap, %s%% survival, %s%% of first-time buyers ever reorder) x %s%% margin = %s.',
             '₹' || trim(to_char(aov, 'FM9,999,990')),
             trim(to_char(expected_orders, 'FM9990.00')),
             round(tier_median_gap, 0),
             tier,
             greatest(5, round(100 - churn_risk)),
             round(repeat_rate * 100),
             round(margin * 100),
             '₹' || trim(to_char(predicted_ltv, 'FM9,999,990')))
    else
      format('AOV %s x %s expected orders over 12 months (their own %s-day gap, %s%% survival) x %s%% margin = %s.',
             '₹' || trim(to_char(aov, 'FM9,999,990')),
             trim(to_char(expected_orders, 'FM9990.00')),
             trim(to_char(median_gap, 'FM9990.0')),
             greatest(5, round(100 - churn_risk)),
             round(margin * 100),
             '₹' || trim(to_char(predicted_ltv, 'FM9,999,990')))
  end,

  -- ---- next_order_date (§F3.4) ----------------------------------------
  -- THE UNCLAMPED PREDICTION. This column is a forecast, not a trigger.
  --
  -- It used to be `greatest(due_date, today)`, clamped forward so that the
  -- replenishment nudge (§F6.2) would never carry a fire date in the past.
  -- That was wrong for three reasons, all of which showed up live:
  --
  --   1. It made one column serve two incompatible jobs. §F3.4 asks for a
  --      prediction (what the CRM displays and the agent queries); §F6.2
  --      wants a trigger fire date (necessarily forward-looking). The clamp
  --      sacrificed the prediction for a consumer that does not exist yet.
  --   2. It contradicted its own reason on screen. The profile page renders
  --      this date beside next_order_reason, producing "24 Aug 2026" next to
  --      "Was due 21 Apr 2025 — 490 days overdue". §F3.6 makes reason-beside-
  --      score non-negotiable; two numbers disagreeing in one row is worse
  --      than no reason at all.
  --   3. It made `next_order_date < current_date` mean "the scores are
  --      stale", not "the customer is overdue" — so the agent's own overdue
  --      query returned a plausible number only while nobody had re-scored,
  --      and collapsed the moment anyone did. A demo-day rescore, which the
  --      now()-based ruling requires, would have broken the demo.
  --
  -- If §F6.2 later needs a guaranteed-future fire date, it should clamp at
  -- trigger time or get its own column. Do not clamp the forecast.
  case when order_count = 0 then null else due_date end,

  -- ---- next_order_reason (§F3.6) --------------------------------------
  case
    when order_count = 0 then 'No orders yet — nothing to predict a repeat from.'
    when due_date >= today then
      format('Last ordered %s; %s -> due %s%s.',
             to_char(last_at at time zone 'UTC', 'DD Mon YYYY'),
             case when median_gap is not null and repl_days is not null
                    then format('own %s-day gap blended with the %s-day %s of %s',
                                trim(to_char(median_gap, 'FM9990.0')),
                                round(repl_days),
                                case when tier = 'care' then 'refill cycle' else 'attach window' end,
                                repl_driver)
                  when median_gap is not null
                    then format('own %s-day gap', trim(to_char(median_gap, 'FM9990.0')))
                  when repl_days is not null
                    then format('the %s-day %s of %s, their only order — no personal gap yet',
                                round(repl_days),
                                case when tier = 'care' then 'refill cycle' else 'attach window' end,
                                repl_driver)
                  else format('%s-day %s-tier median gap (no personal or product cadence)',
                              round(tier_median_gap, 0), tier) end,
             to_char(due_date, 'DD Mon YYYY'),
             case when due_date = today then ' — today' else '' end)
    else
      format('Was due %s (last ordered %s, %s) — %s days overdue, %s',
             to_char(due_date, 'DD Mon YYYY'),
             to_char(last_at at time zone 'UTC', 'DD Mon YYYY'),
             case when median_gap is not null and repl_days is not null
                    then format('own %s-day gap blended with the %s-day %s of %s',
                                trim(to_char(median_gap, 'FM9990.0')),
                                round(repl_days),
                                case when tier = 'care' then 'refill cycle' else 'attach window' end,
                                repl_driver)
                  when median_gap is not null
                    then format('own %s-day gap', trim(to_char(median_gap, 'FM9990.0')))
                  when repl_days is not null
                    then format('the %s-day %s of %s, their only order — no personal gap yet',
                                round(repl_days),
                                case when tier = 'care' then 'refill cycle' else 'attach window' end,
                                repl_driver)
                  else format('%s-day %s-tier median gap (no personal or product cadence)',
                              round(tier_median_gap, 0), tier) end,
             (today - due_date),
             case when tier = 'care' then 'nudge now.'
                  else 'suggest the next piece for the room now.' end)
  end,

  median_gap::numeric(6,1),
  days_since,
  order_count,
  lifetime_value,
  aov,
  now()
from computed
where $1::uuid is null or customer_id = $1::uuid
on conflict (customer_id) do update set
  rfm_r                 = excluded.rfm_r,
  rfm_f                 = excluded.rfm_f,
  rfm_m                 = excluded.rfm_m,
  segment               = excluded.segment,
  churn_risk            = excluded.churn_risk,
  churn_reason          = excluded.churn_reason,
  predicted_ltv         = excluded.predicted_ltv,
  ltv_reason            = excluded.ltv_reason,
  next_order_date       = excluded.next_order_date,
  next_order_reason     = excluded.next_order_reason,
  median_interval_days  = excluded.median_interval_days,
  days_since_last_order = excluded.days_since_last_order,
  order_count           = excluded.order_count,
  lifetime_value        = excluded.lifetime_value,
  aov                   = excluded.aov,
  computed_at           = excluded.computed_at;
