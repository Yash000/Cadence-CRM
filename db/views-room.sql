-- =========================================================================
-- v_room_completion — the view behind the Room Completion Board.
--
-- Apply with:  npm run apply-room-view
--              (or: psql "$DATABASE_URL" -f db/views-room.sql)
--
-- This file is idempotent (CREATE OR REPLACE + idempotent GRANT) and is safe
-- to re-run. It creates NO tables and alters none, so it does not contradict
-- the "the live database is authoritative, do not migrate" rule in
-- db/schema.ts — a view is a saved query over tables that already exist.
--
-- NOTE ON THE OTHER FOUR VIEWS. v_customer_360, v_order_facts,
-- v_customer_scores and v_conversation_summary have no definition checked into
-- this repo; they exist only in Supabase. That is a real gap, and this file is
-- deliberately the first view whose source lives in git rather than only in a
-- dashboard. It does not fix the other four.
--
-- WHY THIS VIEW EXISTS
-- --------------------
-- Furniture does not replenish (see db/scoring.sql header note 1b), so the
-- question "what do we sell this customer next?" cannot be answered by
-- reordering what they already bought. It is answered by looking at the ROOM
-- they started, seeing which pieces of it they do not own, and ranking those
-- by how often that piece actually follows the room's anchor in real orders.
--
-- Every recommendation this view makes therefore carries its own evidence:
-- next_best_attach_rate is measured from order_items, not assigned by hand. If
-- 54% of customers who bought a sofa later bought the rug, the rug scores
-- 0.54, and the operator can see that number next to the suggestion. That is
-- the same rule the scoring job follows — no number without its reason.
--
-- GRAIN: one row per (customer, room) for every room the customer has bought
-- AT LEAST ONE piece of. A customer furnishing two rooms appears twice, so
-- count customers with count(distinct customer_id), never count(*).
-- care-decor is not a room and never appears here.
-- =========================================================================

create or replace view v_room_completion as

with today as (
  -- Derived in UTC explicitly, matching db/scoring.sql, so "days since" does
  -- not depend on whichever timezone a pooled connection inherited.
  select (now() at time zone 'UTC')::date as d
),

-- The catalogue side: what a complete room actually consists of.
room_products as (
  select
    p.id,
    p.title,
    p.handle,
    p.collection                as room,
    p.price,
    p.replenishment_days,
    ('anchor' = any(p.tags))    as is_anchor
  from products p
  where p.collection in ('living-room', 'bedroom', 'dining')
    and p.status = 'active'
),

room_size as (
  select
    room,
    count(*)::int as pieces_total,
    -- The room's typical spacing between pieces, from the catalogue. For the
    -- room tier `replenishment_days` is an attach window, not a refill cycle.
    percentile_cont(0.5) within group (order by replenishment_days)::int
      as attach_window_days
  from room_products
  group by room
),

anchor_of_room as (
  select room, id as anchor_id, title as anchor_title
  from room_products
  where is_anchor
),

-- Revenue-bearing purchases only, one row per customer per product, dated at
-- the FIRST time they bought it. Cancelled and refunded orders are not
-- purchases and must not put a piece in somebody's room.
bought as (
  select
    o.customer_id,
    rp.id            as product_id,
    rp.room,
    min(o.processed_at) as bought_at
  from orders o
  join order_items oi on oi.order_id = o.id
  join room_products rp on rp.id = oi.product_id
  where o.customer_id is not null
    and o.cancelled_at is null
    and o.financial_status in ('paid', 'partially_refunded', 'authorized')
  group by o.customer_id, rp.id, rp.room
),

-- ---------------------------------------------------------------------------
-- ATTACH RATES — the evidence behind every recommendation.
--
-- Denominator is customers who bought the room's ANCHOR, not everyone who
-- touched the room. "How often does a rug follow a sofa" is a question about
-- sofa owners; including people who only ever bought a rug would deflate every
-- rate by dividing by a population that was never at risk of the behaviour.
-- ---------------------------------------------------------------------------
anchor_owner as (
  select b.customer_id, b.room
  from bought b
  join anchor_of_room a on a.room = b.room and a.anchor_id = b.product_id
),

anchor_owner_count as (
  select room, count(*)::numeric as n
  from anchor_owner
  group by room
),

piece_attach as (
  select
    ao.room,
    rp.id                                as product_id,
    count(distinct b.customer_id)::numeric as buyers
  from anchor_owner ao
  join room_products rp
    on rp.room = ao.room
   and not rp.is_anchor
  left join bought b
    on b.customer_id = ao.customer_id
   and b.product_id  = rp.id
  group by ao.room, rp.id
),

attach as (
  select pa.room, pa.product_id,
         round(pa.buyers / nullif(aoc.n, 0), 4) as attach_rate
  from piece_attach pa
  join anchor_owner_count aoc on aoc.room = pa.room
  union all
  -- The anchor's own rate is 1 by definition (every anchor owner owns it). It
  -- is listed so that a customer who somehow owns companions but not the
  -- anchor still gets the anchor ranked first among their missing pieces,
  -- which is the correct advice: sell them the piece the room is built around.
  select room, anchor_id, 1.0000 from anchor_of_room
),

-- ---------------------------------------------------------------------------
-- The customer side.
-- ---------------------------------------------------------------------------
customer_room as (
  select
    b.customer_id,
    b.room,
    count(*)::int                                  as pieces_owned,
    max(b.bought_at)                               as last_piece_at,
    array_agg(rp.title order by b.bought_at, rp.title) as owned_titles
  from bought b
  join room_products rp on rp.id = b.product_id
  group by b.customer_id, b.room
),

customer_anchor as (
  select b.customer_id, b.room, b.bought_at as anchor_bought_at
  from bought b
  join anchor_of_room a on a.room = b.room and a.anchor_id = b.product_id
),

-- Missing pieces, ranked. Attach rate first (what actually happens), then
-- price descending as the tie-break — between two equally likely pieces the
-- more valuable one is the better thing to put in front of an operator.
missing as (
  select
    cr.customer_id,
    cr.room,
    rp.title,
    rp.price,
    at.attach_rate,
    row_number() over (
      partition by cr.customer_id, cr.room
      order by at.attach_rate desc nulls last, rp.price desc nulls last, rp.title
    ) as rn
  from customer_room cr
  join room_products rp on rp.room = cr.room
  left join attach at on at.room = rp.room and at.product_id = rp.id
  where not exists (
    select 1 from bought b
    where b.customer_id = cr.customer_id
      and b.product_id  = rp.id
  )
),

missing_agg as (
  select
    customer_id,
    room,
    array_agg(title order by rn)                as missing_titles,
    sum(price)::numeric(12,2)                   as room_value_remaining,
    (array_agg(title       order by rn))[1]     as next_best_title,
    (array_agg(price       order by rn))[1]     as next_best_price,
    (array_agg(attach_rate order by rn))[1]     as next_best_attach_rate
  from missing
  group by customer_id, room
)

select
  cr.customer_id,
  cr.room,
  rs.pieces_total,
  cr.pieces_owned,
  round(100.0 * cr.pieces_owned / nullif(rs.pieces_total, 0))::int as completion_pct,
  ar.anchor_title,
  ca.anchor_bought_at,
  case when ca.anchor_bought_at is not null
       then (t.d - (ca.anchor_bought_at at time zone 'UTC')::date) end as days_since_anchor,
  cr.last_piece_at,
  (t.d - (cr.last_piece_at at time zone 'UTC')::date)                 as days_since_last_piece,
  rs.attach_window_days,
  -- Negative once the window has passed. That is the normal state of a stalled
  -- room, not a data error, and it is deliberately NOT clamped at zero: the
  -- magnitude is how the board sorts "slipping away" from "still warm", the
  -- same reasoning that left next_order_date unclamped in db/scoring.sql.
  (rs.attach_window_days - (t.d - (cr.last_piece_at at time zone 'UTC')::date)) as window_closes_in_days,
  cr.owned_titles,
  coalesce(ma.missing_titles, '{}'::text[])                           as missing_titles,
  ma.next_best_title,
  ma.next_best_price,
  ma.next_best_attach_rate,
  coalesce(ma.room_value_remaining, 0)::numeric(12,2)                 as room_value_remaining
from customer_room cr
cross join today t
join room_size rs      on rs.room = cr.room
join anchor_of_room ar on ar.room = cr.room
left join customer_anchor ca on ca.customer_id = cr.customer_id and ca.room = cr.room
left join missing_agg ma     on ma.customer_id = cr.customer_id and ma.room = cr.room;

-- The AI agent role reads this view like the other four (PRD-02 §F4.3). It is
-- SELECT only, and the view exposes no phone, email or full name — the same
-- PII masking the other agent views are held to.
grant select on v_room_completion to cadence_agent;
