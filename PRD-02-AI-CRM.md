# PRD 02 — AI-Powered CRM ("Cadence")

**Version:** 1.1
**Owner:** Yash
**Status:** Draft for build
**Related:** PRD 01 — Rasaya (Demo Storefront)
**Change log:** v1.1 renamed product to Cadence; added naming rationale to §2.

---

## 1. Problem statement

Small and mid-sized Indian D2C brands sit on rich transactional data in Shopify and have no practical way to act on it. In current practice:

- Customer segmentation is done by exporting CSVs and filtering by hand, if at all
- Churn is noticed only when monthly revenue drops, weeks after the customers left
- WhatsApp — the dominant channel for Indian consumers — lives entirely outside the CRM, in an operator's personal phone, with no history and no attribution
- Answering "which customers should I message this week?" requires a person who can write SQL

Enterprise platforms solve this at enterprise prices and enterprise setup cost. The gap is a CRM that reads e-commerce data, reasons about it, and acts through the channels Indian customers actually use.

## 2. Product thesis

**Cadence is an intelligence and action layer on top of a Shopify store.**

The name states the core insight: churn is measured against each customer's **own** purchase rhythm, not a global average. A 90-day gap means nothing in isolation — it means everything for a customer whose median interval is 35 days. Every predictive feature in this product derives from that per-customer cadence.

Shopify remains the system of record for transactions. Cadence maintains its own store where that data is enriched with scores, segments, conversations, and AI outputs — the same separation Klaviyo and HubSpot use. Three layers:

1. **Data** — reliable, real-time, unified customer records
2. **Intelligence** — segmentation, prediction, and a natural-language agent over the whole dataset
3. **Action** — omnichannel outreach, with WhatsApp as a first-class channel rather than a bolt-on

## 3. Users

| Persona | Needs | Primary surfaces |
|---|---|---|
| **Founder / owner** | Revenue and retention health, "who's leaving and why" | Dashboard, AI agent |
| **Marketing executive** | Build segments, run campaigns, measure lift | Segments, Campaigns |
| **Support / sales rep** | Answer customers with full context | Inbox, Customer 360, Task queue |

## 4. Success criteria

This is a prototype; success is demo-legibility, not scale.

| Criterion | Target |
|---|---|
| Live order → visible in CRM | < 5 seconds |
| Dashboard load | < 500ms (precomputed scores) |
| AI agent response | < 8 seconds end-to-end |
| Agent SQL accuracy on 20 benchmark questions | ≥ 85% |
| Cost per agent query | Logged and displayed |
| Demo path completable | Without a network dependency on the live store |

---

## 5. Scope

### In scope (v1)

Customer 360, RFM segmentation, churn and LTV scoring, natural-language SQL agent, WhatsApp + email messaging with unified timeline, AI drafting and summarisation, abandoned-cart and win-back flows, campaign sending, AI ops logging.

### Out of scope (v1)

Multi-store / multi-tenant onboarding, deliverability infrastructure, A/B testing, billing, mobile app, non-Shopify connectors, trained ML models beyond interpretable heuristics.

### Explicitly deferred

Marketing attribution modelling, subscription management, loyalty points.

---

## 6. Data model

### 6.1 Core entities

| Table | Purpose | Key fields |
|---|---|---|
| `customers` | Master profile | `shopify_customer_id` (unique), `email`, `phone_e164` (unique), name, city, `created_at` |
| `orders` | Transaction header | `shopify_order_id` (unique), `customer_id`, `total`, `financial_status`, `processed_at` |
| `order_items` | Line items | `order_id`, `product_id`, `variant_id`, `qty`, `price` |
| `products` | Catalogue mirror | `shopify_product_id`, title, collection, tags, `replenishment_days` |
| `events` | Behavioural stream | `customer_id` (nullable), `type`, `payload` jsonb, `occurred_at` |
| `consents` | Channel permissions | `customer_id`, `channel`, `status`, `source`, `updated_at` |
| `customer_scores` | Precomputed intelligence | `customer_id`, `rfm_r/f/m`, `segment`, `churn_risk`, `predicted_ltv`, `next_order_date`, `computed_at` |
| `segments` | Saved definitions | `name`, `definition` jsonb, `is_dynamic` |
| `conversations` | Channel thread | `customer_id` (nullable), `channel`, `status`, `last_message_at` |
| `messages` | Individual messages | `conversation_id`, `direction`, `body`, `template_id`, `status`, `sent_at` |
| `templates` | Pre-approved message bodies | `channel`, `name`, `body`, `approval_status` |
| `campaigns` | Sends to a segment | `segment_id`, `template_id`, `channel`, `scheduled_at`, `stats` |
| `tasks` | Rep work queue | `customer_id`, `type`, `reason`, `priority`, `status` |
| `ai_logs` | Every model call | `feature`, `model`, `prompt_tokens`, `completion_tokens`, `cost`, `latency_ms`, `outcome` |

### 6.2 Design decisions

**Conversations and messages are first-class entities**, not JSON blobs hanging off customers. Every channel — WhatsApp, email, future SMS — writes to the same abstraction. This is what makes the unified timeline possible and prevents the WhatsApp layer being bolted on separately.

**Scores are precomputed, never calculated on page load.** A nightly job writes `customer_scores`. The difference between a 200ms dashboard and an 8-second hang in front of an evaluator.

**Phone numbers are stored E.164, always.** This is the join key between Shopify identity and WhatsApp identity.

### 6.3 Read-only views for the agent

`v_customer_360`, `v_order_facts`, `v_customer_scores`, `v_conversation_summary` — PII masked or excluded, denormalised for query simplicity. The AI agent queries **only these**, never base tables.

---

## 7. Functional requirements

### F1 — Shopify sync

**F1.1** Webhook endpoint at `/api/webhooks/shopify` accepting all topics from PRD 01 §6.2
**F1.2** HMAC verification against raw request body; reject unverified requests with 401
**F1.3** Return 200 within 5s; enqueue processing to a background job
**F1.4** Idempotent upsert on `shopify_order_id` / `shopify_customer_id`
**F1.5** Identity resolution: match inbound records to existing customers by normalised phone, then email
**F1.6** Backfill job to pull historical data via Admin GraphQL bulk operations
**F1.7** Sync health page: last webhook received per topic, failure count, replay control

### F2 — Customer 360

**F2.1** Searchable, sortable, filterable customer list with segment and churn-risk columns
**F2.2** Profile header: identity, lifetime value, order count, segment badge, churn risk with reason
**F2.3** **Unified timeline** interleaving orders, events, WhatsApp messages, emails, tickets, and campaign sends in one chronological stream
**F2.4** AI account brief — four lines: who they are, what they buy, why they're at risk, what to do next
**F2.5** Manual merge control for unmatched contacts

> F2.3 is the flagship screen. It is the capability spreadsheets fundamentally cannot replicate and should anchor the demo.

### F3 — Segmentation & scoring

**F3.1** RFM scoring via `NTILE(5)` over recency, frequency, monetary; mapped to 11 named segments
**F3.2** Churn risk computed against each customer's **own** median inter-purchase gap, not a global average
**F3.3** Predicted LTV (heuristic: AOV × predicted future frequency × margin assumption)
**F3.4** Predicted next order date from personal cadence and product `replenishment_days`
**F3.5** Product affinity — co-purchase pairs at category and SKU level
**F3.6** **Every score displays its reason inline** — e.g. "3 orders, last 142 days ago, typical gap 45 days"
**F3.7** Nightly recompute job; manual "recompute now" trigger for demos

> F3.6 is non-negotiable. Unexplained scores read as hallucination and invite exactly the questions you don't want mid-demo.

### F4 — AI agent (natural language → data)

**F4.1** Chat interface answering open-ended questions across the customer dataset
**F4.2** Text-to-SQL generation constrained to the read-only views
**F4.3** **Execution under a dedicated read-only Postgres role** with `SELECT` granted only on views — no INSERT/UPDATE/DELETE, no DDL, no access to auth or `ai_logs` tables
**F4.4** Pre-execution validation: single `SELECT` only; reject semicolons, multiple statements, comment tokens; force-append `LIMIT 500`; `statement_timeout = 5s`
**F4.5** Generated SQL shown to the user in a collapsible panel alongside every answer
**F4.6** Results rendered as a table beneath the natural-language answer
**F4.7** Tool belt beyond SQL: `get_customer_brief`, `search_conversations` (semantic, pgvector), `draft_message`
**F4.8** 8–10 few-shot examples in the system prompt, written against the actual schema
**F4.9** Every call logged to `ai_logs` with token counts, cost, and latency

> **Security posture:** the risk is not that a model writes SQL — it's SQL executing with application privileges. F4.3 is the control that matters; F4.4 is defence in depth. A prompt injection instructing "drop the customers table" returns a permission error.

### F5 — Omnichannel messaging

**F5.1** WhatsApp integration (Twilio Sandbox for v1) — inbound webhook and outbound send
**F5.2** Email integration (Resend) — outbound send, delivery status
**F5.3** Unified inbox: all conversations across channels, filterable, assignable
**F5.4** Identity resolution on inbound WhatsApp by E.164 phone; unmatched messages land in an "unknown contacts" queue with manual merge
**F5.5** Template library with per-template approval status
**F5.6** **24-hour session window enforcement** — outside the window from the customer's last inbound message, only approved templates may be sent; the UI must block free-form sends and explain why
**F5.7** Consent gating — no marketing message sends without a recorded opt-in on that channel
**F5.8** Channel routing rules with visible reasoning (e.g. high-value + at-risk → WhatsApp; routine post-purchase → email)
**F5.9** AI reply drafting — inbound message + order history + segment → contextual draft, rep edits before send
**F5.10** Conversation summarisation and intent tagging (`order_status`, `return_request`, `product_question`, `complaint`)
**F5.11** **Channel simulator** — an in-app fake WhatsApp client posting to the same inbound webhook, for deterministic demos independent of network conditions

> F5.6 and F5.7 are the details that read as production-grade. Most student prototypes send free-form WhatsApp messages to anyone, which is not a thing the real API permits.

### F6 — Flows & campaigns

**F6.1** Abandoned cart recovery: trigger → wait → channel-routed send → outcome, with the chain visible in the UI
**F6.2** Replenishment nudge fired on predicted next order date
**F6.3** Win-back for At Risk and Hibernating segments
**F6.4** Post-purchase thank-you and cross-sell
**F6.5** One-off campaign send to a saved segment
**F6.6** Per-campaign stats: sent, delivered, replied, orders attributed, revenue

### F7 — Dashboard

**F7.1** Revenue, orders, AOV, repeat rate, with period comparison
**F7.2** Segment distribution chart
**F7.3** Churn risk distribution and at-risk revenue at stake
**F7.4** Cohort retention grid
**F7.5** Today's task queue with per-task reasoning

### F8 — AI operations

**F8.1** Log of every model call: feature, model, tokens, cost, latency, outcome
**F8.2** Aggregate cost view by feature and by day
**F8.3** Agent query history with generated SQL and success/failure

> Unit-economics visibility ("this query cost ₹0.14") is a strong differentiator. Almost no prototype tracks it.

### F9 — Auth & access

**F9.1** Supabase Auth with row-level security
**F9.2** Roles: Admin (full access) and Agent (inbox and customer records; no revenue dashboards)

---

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| **Performance** | Dashboard < 500ms; agent < 8s; webhook ack < 5s |
| **Reliability** | Webhook retries handled idempotently; LLM failures degrade gracefully with a stated fallback |
| **Security** | Read-only DB role for agent; HMAC on all webhooks; secrets in env vars only; RLS on all tables |
| **Data protection** | Consent recorded per channel with source and timestamp; DPDP Act alignment stated; PII excluded from agent-accessible views |
| **Observability** | Every AI call and every webhook logged |
| **Cost** | Total build spend under ₹500 |

---

## 9. Technical architecture

**Frontend / backend:** Next.js 15 (App Router, TypeScript) on Vercel — Server Components for dashboards, Route Handlers for webhooks and agent endpoints.

**Database:** Supabase Postgres with `pgvector`. Drizzle ORM (lighter than Prisma, better raw-SQL ergonomics for hand-tuned RFM queries). Second read-only role for the agent.

**Background jobs:** Inngest — scoring recompute, scheduled campaigns, webhook processing. Works on Vercel's serverless model where plain cron does not.

**AI:** Vercel AI SDK pointed at OpenRouter (OpenAI-compatible; no per-token markup; one-line model swap).

| Job | Model | Rationale |
|---|---|---|
| SQL agent, account briefs, drafting | `openai/gpt-5-mini` | Tool calling + structured outputs; ~$0.25/M in |
| Intent tagging, summarisation | Free-tier model | Background jobs tolerate rate limits |
| Embeddings | `text-embedding-3-small` | Cheapest path |

All LLM JSON output validated with **Zod** before touching the database. No LangChain — the abstraction costs more debugging time than it saves.

**UI:** Tailwind + shadcn/ui, Recharts, TanStack Table, Lucide.

**Integrations:** Shopify Admin GraphQL + webhooks (`@shopify/shopify-api` for HMAC), Twilio WhatsApp Sandbox, Resend.

---

## 10. Build sequence

Dependency-ordered. The agent is the flashiest piece and the most tempting to start with; it is worthless without data and views beneath it.

| Phase | Deliverable | Gate |
|---|---|---|
| 1 | Drizzle schema + migrations + read-only role | Tables and views exist; role permissions verified |
| 2 | Seed script | 800 customers, 3,000 orders, cohort distribution verified |
| 3 | RFM + scoring job | Segment spread matches §PRD-01 5.3 targets |
| 4 | Shopify custom app + webhook handler | Live test order lands in < 5s |
| 5 | Dashboard + Customer 360 + timeline | Flagship screen demo-ready |
| 6 | WhatsApp + inbox + simulator | Inbound message resolves to a customer |
| 7 | Flows + campaigns | Abandoned cart chain fires end to end |
| 8 | AI agent + AI ops | 85% accuracy on 20 benchmark questions |
| 9 | Demo hardening | Full path runs offline from the live store |

---

## 11. Demo script

Five minutes. The win condition is a moment a rules engine visibly could not produce.

1. **Dashboard** — revenue, segment distribution, at-risk revenue at stake *(15s)*
2. **Agent** — "Which customers bought hair oil twice but nothing in the last 90 days, and what's their total value?" Answer, table, expand the SQL *(60s)*
3. **Customer 360** — open one result; unified timeline across orders, browse events, and WhatsApp; AI brief with the churn reason spelled out *(60s)*
4. **AI drafting** — draft a win-back that references her actual last order; edit; send via WhatsApp *(45s)*
5. **Live loop** — place an order in the storefront; webhook fires; her segment flips from At Risk to Loyal on screen *(45s)*
6. **AI ops** — per-query cost and latency *(15s)*

**Demo safety:** every step must have an offline path. The channel simulator (F5.11) and manual recompute trigger (F3.7) exist for this reason.

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Agent SQL accuracy below target | Core feature embarrasses on stage | Few-shot examples written against real schema; 20-question benchmark run before demo; fall back to saved segments |
| Seeded data lacks cohort spread | Every AI feature returns nothing interesting | Cohort distribution is an explicit seed requirement, verified post-seed |
| WhatsApp sandbox restrictions surprise | Messaging demo fails | Sandbox chosen deliberately over production API; simulator as fallback |
| 24-hour window blocks the demo send | Send fails live | Rehearse with a fresh inbound message; templates pre-approved |
| Scores computed on page load | Slow dashboard | Precompute to `customer_scores`; enforced in phase 3 |
| Scope creep into storefront polish | Time lost to non-deliverable | PRD 01 §1 non-goals |
| LLM returns malformed JSON | Runtime crash | Zod validation with explicit fallback paths on every call |

---

## 13. Open questions

1. Does the assessment credit originality? If so, the two-wheeler accessories vertical is more defensible and more memorable, given direct operating experience.
2. Should the agent be able to *take* actions (create a task, send a draft) or remain read-only? Read-only is safer for v1; action-taking is a stronger story.
3. Is multi-tenancy worth demonstrating, or does it cost more than it shows?
