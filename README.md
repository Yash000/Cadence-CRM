# Cadence CRM

An AI-native retention CRM for **HomeStyle Furniture**, a demo Shopify store. Cadence
syncs commerce data from Shopify, scores every customer for churn / LTV / segment
against **their own** purchase rhythm, and puts the reason next to every number.
It also runs a natural-language SQL agent over read-only views and a unified
omnichannel inbox with AI-drafted replies.

This repo is the CRM application plus its data tooling. The storefront theme lives
alongside it in [`homestyle-theme/`](homestyle-theme/) (a Shopify Dawn fork).

> Internal specs, the design system doc, and the build-plan/status doc are kept
> locally (not published in this repo) — ask the maintainer if you need them.

> **Note on branding.** The project was originally scoped around a skincare brand
> called *Rasaya*; it was rebranded to *HomeStyle Furniture*. Some spec documents
> and the Shopify dev-store domain (`rasaya-dev.myshopify.com`) still carry the old
> name — see [docs/homestyle-reseed-runbook.md](docs/homestyle-reseed-runbook.md).

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 (App Router, RSC) + TypeScript |
| Data | Drizzle ORM over Supabase Postgres — **mirror of a live schema, no migrations** |
| AI | Vercel AI SDK → OpenRouter (`openai/gpt-5-mini`), Zod-validated |
| Email | Resend (real send for the email channel) |
| UI | Tailwind v4, shadcn/ui, Recharts |
| Tests | `node:test` (`node --test`) |

The Postgres schema is **authoritative and already provisioned** (Supabase project
`pldjtgzmwtgrlyygslvl`). [`db/schema.ts`](db/schema.ts) mirrors it by hand;
`drizzle-kit` is wired for `introspect`/`studio` only. Never run `drizzle-kit
push`/`migrate` against it.

## Prerequisites

- Node 22+
- **Cloudflare WARP** — the local network blocks Postgres ports 5432/6543. Connect
  WARP before any Drizzle / `psql` / seed / test work. HTTPS (Shopify, OpenRouter,
  Resend) is unaffected.
- A `.env.local` in the repo root (git-ignored, never commit it):

  ```
  DATABASE_URL=            # Supabase session pooler, port 6543, `postgres` role
  AGENT_DATABASE_URL=      # the crippled read-only `cadence_agent` role — views only
  OPENROUTER_API_KEY=      # AI agent + inbox draft generation
  RESEND_API_KEY=          # outbound email
  RESEND_FROM=             # optional; defaults to onboarding@resend.dev
  SHOPIFY_STORE_DOMAIN=    # rasaya-dev.myshopify.com
  SHOPIFY_API_SECRET=      # webhook HMAC verification
  ```

## Getting started

```sh
npm install
# WARP on
npm run dev            # http://localhost:3000
```

### npm scripts

| Script | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js (Turbopack) |
| `npm run seed` | Bulk analytical seed — 800 customers / ~3,000 orders / 18 months, deterministic and idempotent (`-- --truncate` to reset) |
| `npm run score` | Recompute `customer_scores` (RFM, churn, LTV, next-order) — `-- --customer <id>` for a spot check |
| `npm run seed-inbox` | Seed a handful of demo inbox conversations incl. a held AI draft (`-- --clear` to remove) |
| `npm run apply-room-view` | (Re)create the `v_room_completion` view behind the Rooms surface |
| `npm run capture-ids` | Snapshot live Shopify product/variant ids to `data/shopify-ids.json` |
| `npm run lint` / `typecheck` / `test` | ESLint · `tsc --noEmit` · full `node:test` suite |

DB-touching tests skip themselves with a message when `DATABASE_URL` is unset.

## Surfaces

| Route | What it is |
|---|---|
| `/` | Dashboard — revenue/AOV/repeat with period comparison, segment & churn distribution, at-risk revenue, task queue with per-task reasoning |
| `/customers` | Searchable, sortable, filterable list with segment + churn columns |
| `/customer-360/[id]` | Profile, scores **with reasons**, consent/reachability, the unified timeline |
| `/rooms` | Room-completion cross-sell board (`v_room_completion`) — attach-rate evidence per suggestion |
| `/ask` | Natural-language → SQL agent; generated SQL shown beside every answer, executed as `cadence_agent` |
| `/inbox` | Omnichannel conversation view + AI draft approve/reject ([details](docs/inbox.md)) |
| `/simulator` | Storefront event simulator — PRD-01 §7 offline fallback for the theme's tracking snippet |

## Data flow

```
Shopify  ──webhooks──▶  /api/webhooks/shopify  ──▶  Postgres (customers, orders, …)
theme tracking / simulator  ──▶  /api/events   ──▶  events
scripts/recompute-scores.mjs (db/scoring.sql)  ──▶  customer_scores
Inbox simulator / seed  ──▶  /api/inbox/simulate  ──▶  conversations, messages
AI agent  ──AGENT_DATABASE_URL──▶  v_customer_360 · v_order_facts · v_customer_scores · v_conversation_summary
```

## Automation layer (n8n)

[`n8n-space/`](n8n-space/) runs a separate [n8n](https://n8n.io) instance in local
Docker — the event-driven half of the system, distinct from the Next.js app,
sharing only the Supabase database. Five workflows: Shopify order ingest,
nightly score recompute (triggers the real `db/scoring.sql` job, then
independently verifies the write landed), room-completion outreach via Resend,
Ask Cadence rebuilt as an n8n AI Agent, and inbox reply-drafting as a
structured LLM call. See [`n8n-space/README.md`](n8n-space/README.md) for what
each shows and [`n8n-space/SETUP.md`](n8n-space/SETUP.md) to run it.

By default nothing in `app/`, `components/`, or `lib/` talks to n8n. Two
opt-in `.env.local` toggles (`AGENT_VIA_N8N_WEBHOOK`,
`INBOX_DRAFT_VIA_N8N_WEBHOOK`) route the real `/ask` and inbox-draft requests
through n8n instead, for demos — each needs a `npm run dev` restart to take
effect, and each drops some real-path logic (conversation memory, `sql-guard.ts`,
real token accounting) that the in-process path has. Unset both for normal
development.

## Security posture

- The AI agent connects **only** as `cadence_agent` (`AGENT_DATABASE_URL`), which
  has `SELECT` on four views and nothing else. `scripts/verify-agent-role.mjs`
  proves the isolation — do not weaken it.
- Shopify webhooks are HMAC-verified against the **raw** body before parsing.
- `.env.local` is git-ignored. Keep it that way.
