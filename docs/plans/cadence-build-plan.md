# Cadence Build Plan

**Spec:** [PRD-01-Shopify-Store.md](../../PRD-01-Shopify-Store.md), [PRD-02-AI-CRM.md](../../PRD-02-AI-CRM.md)
**Status:** foundation complete (Supabase schema, Rasaya catalogue, Shopify tooling); application unbuilt.

## Global Constraints

1. **Money is `numeric(12,2)`, never float.** Currency is INR throughout.
2. **Phone numbers are E.164 (`+91XXXXXXXXXX`) everywhere.** `customers.phone_e164`
   carries a CHECK constraint enforcing this. It is the join key between Shopify
   identity and WhatsApp identity.
3. **`processed_at` / `processedAt` is always set explicitly on seeded orders.**
   PRD-01 §5.4: if every order carries today's date, every customer scores as a
   Champion and the entire segmentation demo collapses.
4. **Scores are precomputed into `customer_scores`, never calculated on page load.**
   PRD-02 §6.2. Dashboard budget is 500ms.
5. **Every score carries its reason inline** (PRD-02 §F3.6, "non-negotiable").
   The `*_reason` columns exist for this; populate them.
6. **Churn is measured against each customer's OWN median inter-purchase gap**,
   never a global average (PRD-02 §F3.2). This is the product thesis.
7. **The AI agent queries ONLY the four `v_*` views**, connecting as
   `cadence_agent` via `AGENT_DATABASE_URL`. Never hand it `DATABASE_URL`.
8. **Shopify writes go through `scripts/lib/shopify.mjs`.** It is the only route
   to an offline token, which `orderCreate` requires. Rate limit is 4.8 orders/min
   (measured) — use `gqlWithBackoff` for order creation.
9. **Never commit secrets.** `.env.local` is git-ignored; keep it that way.
10. **No new dependencies without need.** Stack is fixed by PRD-02 §9: Next.js 15
    App Router + TypeScript, Drizzle, Vercel AI SDK → OpenRouter, Zod, Tailwind +
    shadcn/ui, Recharts, TanStack Table. No LangChain.

## Environment

- Supabase project `pldjtgzmwtgrlyygslvl` (`Cadence CRM`), region ap-southeast-1.
  Schema is already applied — read it, do not recreate it.
- Shopify dev store `rasaya-dev.myshopify.com`, app `cadence-crm` installed.
  12 products / 18 variants / 3 collections live.
- **Postgres connections require Cloudflare WARP** — the local network blocks
  5432/6543. HTTPS is unaffected.
- `.env.local` holds `AGENT_DATABASE_URL`, `OPENROUTER_API_KEY`, `RESEND_API_KEY`,
  `SHOPIFY_STORE_DOMAIN`. `DATABASE_URL` is NOT yet present — Task 1 adds it.

---

## Task 1: Drizzle schema mirroring the live database

**Files:** `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`

The database schema already exists in Postgres (15 tables, 4 views, 11 enums).
Produce Drizzle definitions that match it exactly — this is a mirroring task, not
a design task. Introspect the live schema and hand-write clean definitions.

Requirements:
- Every table in `public`: `customers`, `products`, `orders`, `order_items`,
  `events`, `consents`, `customer_scores`, `segments`, `conversations`,
  `messages`, `templates`, `campaigns`, `tasks`, `ai_logs`, `webhook_log`.
- Every enum: `channel_t`, `consent_status_t`, `direction_t`, `segment_t`,
  `message_status_t`, `conv_status_t`, `approval_status_t`, `task_status_t`,
  `campaign_status_t`, `financial_status_t`.
- `db/index.ts` exports a configured Drizzle client reading `DATABASE_URL`.
- Add `DATABASE_URL` to `.env.local` (session pooler, port 6543, `postgres` user).
- Verify with a query that round-trips at least one row per core table.

**Do NOT** generate migrations that would recreate or alter existing tables. The
live schema is authoritative.

---

## Task 2: Shopify order seed

**Files:** `scripts/seed-shopify.mjs`, `data/shopify-seed.json`

Seed `rasaya-dev` with **30 customers and ~120 orders**, using
`scripts/lib/shopify.mjs`.

Shape (this matters more than volume — PRD-01 §5.2 is superseded here):
- ~30 customers averaging **4 orders each**, so ≥20 have **3 or more orders**.
  Churn scoring needs ≥3 orders to compute a personal median gap; the PRD's
  original 40/80 split averaged 2 and left almost nobody scoreable.
- Orders spread across **18 months**, `processedAt` set explicitly on every one.
- Per-customer cadence drawn from a distribution, not a fixed interval.
- Line items reference **real variants** from `data/catalogue.json` (match by SKU).
- Indian names; cities weighted to metros with a tier-2/3 tail.
- 3–4 customers with **no phone** (forces the §F1.5 identity-resolution edge case).
- Mixed consent states across email and WhatsApp.
- ≥2 customers per named segment so every CRM badge traces to a real Shopify record.
- One deliberate protagonist matching PRD-02 §11: At Risk, phone present, 3+
  orders, last order ~140 days ago, serum buyer.

Use `gqlWithBackoff` — the store throttles at 4.8 orders/min, so expect ~25 min.
Print progress per order. Write the generated dataset to `data/shopify-seed.json`
BEFORE pushing, so the run is reproducible and re-runnable.

---

## Task 3: Supabase bulk seed

**Files:** `scripts/seed-supabase.mjs`

Seed **800 customers / ~3,000 orders / 18 months** directly into Postgres via
Drizzle (Task 1's client). This is the analytical depth the CRM reasons over.

Cohort distribution — PRD-01 §5.3, verify after seeding:

| Cohort | Share | Definition |
|---|---|---|
| Champions | 12% | 5+ orders, last < 30 days, high AOV |
| Loyal | 18% | 3–5 orders, regular cadence |
| Promising | 15% | 2 orders, recent |
| At Risk | 20% | 3+ orders, silent 2–3× their own median gap |
| Hibernating | 20% | 2+ orders, silent 180+ days |
| One-and-done | 15% | single order, 90+ days ago |

Also required:
- Per-customer cadence from a distribution, never a fixed interval.
- Seasonal uplift around Oct–Nov (festive).
- ~15% of customers with **no phone**.
- Mixed consent rows in `consents` (per channel, with `source` and timestamp).
- Abandoned checkouts as `events` at ~3× the completed-order rate.
- `events` rows for `page_view`, `product_view`, `add_to_cart`, `checkout_started`.
- Products referenced must be the real 12 from `data/catalogue.json`.

Idempotent: a re-run must not duplicate. Key on a deterministic seed.
Print a cohort-distribution table at the end and assert it matches the targets.

---

## Task 4: RFM and scoring job

**Files:** `db/scoring.sql`, `scripts/recompute-scores.mjs`

Populate `customer_scores` for every customer.

- **RFM** via `NTILE(5)` over recency, frequency, monetary → the 11 `segment_t`
  values (PRD-02 §F3.1).
- **Churn risk** 0–100 computed against each customer's **own** median
  inter-purchase gap (§F3.2). A customer 90 days silent with a 35-day median is
  high risk; the same gap on a 120-day median is not.
- **Predicted LTV** — AOV × predicted future frequency × margin assumption (§F3.3).
- **Next order date** from personal cadence and the product's
  `replenishment_days` metafield (§F3.4).
- **Every score writes its `*_reason` column** in the style of §F3.6:
  "3 orders, last 142 days ago, typical gap 45 days — 3.2× overdue".
- Idempotent upsert; safe to re-run. Expose a `--customer <id>` flag for spot checks.

Verify: segment spread after running matches the Task 3 cohort targets within a
few percent. Print the distribution.

---

## Task 5: Next.js scaffold

**Files:** `app/`, `package.json`, `tsconfig.json`, `tailwind.config.ts`, `next.config.ts`

Scaffold Next.js 15 (App Router, TypeScript) at the repo root alongside the
existing `scripts/` and `db/`. Tailwind + shadcn/ui. Wire the Drizzle client from
Task 1. Server Components for data pages, Route Handlers for webhooks and agent
endpoints.

Deliver a working shell: root layout, nav matching the five surfaces in the Pulse
mockup (Dashboard, Customers, Customer 360, Ask Cadence, Inbox), and one page that
renders live counts from Postgres to prove the connection works.

**Design reference:** `Pulse CRM Interface Design/Pulse CRM.dc.html` is an
interactive mockup of the intended UI — read it for layout, information density,
and the reasoning-inline pattern. Rename "Pulse"/"Sattva Co." to "Cadence"/"Rasaya".

---

## Task 6: Shopify webhook handler

**Files:** `app/api/webhooks/shopify/route.ts`, `lib/shopify-webhook.ts`

PRD-02 §F1. All seven topics from PRD-01 §6.2.

- **HMAC verified against the RAW request body**, not parsed JSON (§F1.2). Reject
  unverified with 401.
- **Return 200 within 5s**; queue the real work (§F1.3).
- **Idempotent upsert** on `shopify_order_id` / `shopify_customer_id` (§F1.4) —
  the unique constraints are already in the schema.
- **Identity resolution**: match on normalised phone first, then email (§F1.5).
- **Log every webhook to `webhook_log` BEFORE processing** (PRD-01 §6.3.4).
- Unit tests for HMAC verification and idempotency using recorded payloads.

Note: `shopify app dev`'s tunnel fails under WARP, and `--use-localhost` cannot
receive webhooks. Build and unit-test the handler; live delivery is verified later
with WARP off.

---

## Task 7: Dashboard, Customer list, Customer 360

**Files:** `app/(app)/dashboard/`, `app/(app)/customers/`, `app/(app)/customers/[id]/`

PRD-02 §F2 and §F7. The **unified timeline** (§F2.3) is the flagship screen —
interleave orders, events, messages, campaign sends and tickets into one
chronological stream.

- Dashboard: revenue / orders / AOV / repeat rate with period comparison, segment
  distribution, churn distribution, at-risk revenue, today's task queue with
  per-task reasoning.
- Customer list: searchable, sortable, filterable, with segment and churn columns.
- Customer 360: profile header, scores **with reasons visible**, consent and
  reachability panel, unified timeline.
- Dashboard must render in **under 500ms** — read from `customer_scores`, never
  compute on load.

---

## Task 8: AI agent

**Files:** `app/(app)/agent/`, `app/api/agent/route.ts`, `lib/agent/`

PRD-02 §F4. Natural language → SQL over the four views.

- Execute as `cadence_agent` via `AGENT_DATABASE_URL` (§F4.3). **Never**
  `DATABASE_URL`.
- Pre-execution validation (§F4.4): single `SELECT` only; reject semicolons,
  multiple statements and comment tokens; force-append `LIMIT 500`.
- Show the generated SQL in a collapsible panel beside every answer (§F4.5).
- 8–10 few-shot examples written against the ACTUAL schema (§F4.8).
- Log every call to `ai_logs` with tokens, cost and latency (§F4.9).
- Vercel AI SDK → OpenRouter, `openai/gpt-5-mini`. Zod-validate all LLM JSON.

`scripts/verify-agent-role.mjs` already proves the isolation holds — do not
weaken it.

---

## Task 9: Discounts, theme, event instrumentation

**Files:** `scripts/seed-discounts.mjs`, `rasaya-theme/`

- Three discount codes via `scripts/lib/shopify.mjs`: `WELCOME10` (10% first
  order), `COMEBACK15` (15% win-back), `REFILL20` (20% replenishment).
- `shopify theme init` Dawn, light Rasaya branding, push to `rasaya-dev`.
- The §7 tracking snippet posting `page_view`, `product_view`, `add_to_cart`,
  `checkout_started` to the CRM event endpoint.
- Fallback per PRD-01 §7: an in-app event simulator page, labelled as a simulator.

---

## Deferred

- **Messaging (PRD-02 §F5)** — blocked: Twilio WhatsApp Sandbox not configured.
- **Flows and campaigns (§F6)** — depends on messaging.
- **Auth and RLS policies (§F9)** — RLS is enabled deny-by-default; policies land
  with Supabase Auth.
- **Demo hardening (§10 phase 9)** — last.
