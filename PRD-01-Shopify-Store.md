# PRD 01 — Demo Storefront ("Rasaya")

**Version:** 1.3 (Final)
**Owner:** Yash
**Status:** Approved for build
**Related:** PRD 02 — Cadence (AI-Powered CRM)
**Change log:** v1.1 added §4.4 tooling & responsibility split (Shopify CLI workflow, MCP connector limits, manual admin tasks) and revised theme scope to CLI-based customisation. v1.2 added §8 build sequence. v1.3 renamed storefront to Rasaya.

---

## 1. Purpose

This storefront is **not a product**. It is a data-generation and integration-proof surface for the CRM built in PRD 02.

Every decision in this document is judged against one question: *does this produce signal the CRM can act on?* If a feature does not generate customer, order, event, or consent data, it is out of scope.

**Explicit non-goals:**
- Real payments, real shipping, real inventory
- Conversion-rate optimisation, SEO, performance tuning
- Theme development beyond light branding and the event-tracking snippet (see §4.2)
- Any Shopify app installation beyond the CRM app

---

## 2. Vertical & positioning

**Category:** Indian D2C personal care / wellness (face care, hair care, ingestibles)

**Rationale:** The category has a 30–60 day replenishment cycle, which is the single property the CRM's churn, next-order-date, and win-back features depend on. A customer 95 days silent in this category is *visibly* at risk — the same gap in apparel or electronics means nothing. Price points of ₹300–₹1,500 also give enough spread for meaningful RFM monetary quintiles, and category adjacency (hair oil → shampoo → serum) gives the recommendation engine real signal.

**Brand:** Rasaya — from *rasayana* (rejuvenation). Ayurveda-adjacent, clean-label, urban Indian buyer aged 24–40.

> **Before committing to the name:** verify availability on the MCA company search and check domain/handle availability. Indian D2C personal care is crowded and several obvious Sanskrit names are already registered.

---

## 3. Catalogue specification

### 3.1 Structure

| Collection | Products | Price band | Replenishment cycle |
|---|---|---|---|
| Hair Care | 4 | ₹349 – ₹899 | 45 days |
| Skin Care | 5 | ₹399 – ₹1,499 | 35 days |
| Wellness / Ingestibles | 3 | ₹599 – ₹1,299 | 30 days |

**Total: 12 products.** More than this adds seeding effort without adding CRM capability.

### 3.2 Required product attributes

- **Variants** on at least 6 products (size: 100ml / 200ml, or pack: single / duo). Flat line items produce boring basket analysis.
- **Tags** encoding concern (`anti-hairfall`, `acne`, `anti-ageing`, `immunity`) — the CRM uses these for affinity-based recommendations.
- **A `replenishment_days` metafield** per product. This is the input to predicted-next-order-date. Do not skip it; the feature cannot be faked later.
- Product images (free stock or generated), real-sounding descriptions, and ingredient lists. Realism costs an hour and materially improves how the demo reads.

### 3.3 Deliberate catalogue design

Two products should be **entry-point SKUs** (cheap, high-volume, commonly first purchase) and two should be **high-margin anchors**. This gives the CRM a visible "first purchase → upgrade path" story to detect and act on.

---

## 4. Store configuration

### 4.1 Required settings

| Setting | Value | Why it matters to the CRM |
|---|---|---|
| Currency | INR | Money fields and display formatting |
| Customer accounts | Enabled (optional at checkout) | Identity to stitch orders against |
| **Phone field at checkout** | **Required** | **Blocks the entire WhatsApp layer if missed** |
| Email marketing consent | Checkbox at checkout | Consent-gated email sending |
| SMS/WhatsApp consent | Checkbox at checkout | Consent-gated WhatsApp sending |
| Order notifications | Disabled | Prevents spam to fake customer emails during seeding |
| Password protection | Enabled | Keeps the dev store private |

> **Critical:** The phone field is the join key between Shopify identity and WhatsApp identity. Store and transmit it in **E.164 format** (`+91XXXXXXXXXX`). Retrofitting phone normalisation after seeding is painful.

### 4.2 Theme

Dawn (free, Shopify's reference theme), lightly branded: logo, colour palette, homepage hero, About page — plus the event-tracking snippet from §7.

Built and pushed via Shopify CLI, not the admin theme editor:

```bash
shopify theme init rasaya-theme          # scaffolds Dawn locally
cd rasaya-theme
shopify theme dev --store <store>       # local preview, hot reload (~1s)
shopify theme push                      # upload when satisfied
```

Working in the CLI rather than the admin editor matters for one reason: the tracking snippet in §7 is a code change, and `theme dev` gives a sub-second edit-preview loop for getting it right.

**Total effort ceiling: half a day.** The theme is stage dressing — the moment it starts absorbing time, stop.

### 4.3 Discounts

Create three codes the CRM will reference in campaigns:

- `WELCOME10` — 10% off, first order
- `COMEBACK15` — 15% off, win-back campaign
- `REFILL20` — 20% off, replenishment nudge

These let the demo close the loop: CRM sends a win-back → customer redeems → order arrives via webhook → segment flips.

### 4.4 Tooling & responsibility split

Three different mechanisms touch this store. Confusing them costs time, so this section is explicit about which does what.

#### 4.4.1 Shopify CLI — the primary tool

Runs locally on the developer machine. `shopify auth login` requires an interactive browser OAuth handshake, so **the CLI cannot be driven by an AI assistant** — commands are run by the developer. Assistant-generated code is consumed by the CLI as files.

| Command | Purpose |
|---|---|
| `shopify theme init` / `dev` / `push` | Theme scaffold, live preview, upload |
| `shopify app init` | Scaffold the CRM app |
| `shopify app dev` | **Public tunnel + automatic webhook registration** |
| `shopify app deploy` | Push app config and scopes |

> **`shopify app dev` is the single biggest time-saver in this build.** It creates the public tunnel *and* re-registers webhook subscriptions against the current URL on every start. Without it, every dev-server restart means manually updating webhook endpoints — across seven topics, over dozens of restarts.

#### 4.4.2 App type decision

**Use a CLI app (`shopify app init`, Partner account), not a store-admin custom app.**

| | Custom app (admin-created) | CLI app |
|---|---|---|
| Setup | Faster — no Partner account | Partner account required |
| Auth | Offline token, straightforward | Offline token, via CLI config |
| Webhook dev loop | Manual URL updates | Automatic via `app dev` |
| Verdict | — | **Chosen** — webhook iteration dominates this build |

#### 4.4.3 Shopify MCP connector — limited

The connected Shopify MCP surface exposes exactly **one** tool: `find-sample-product`. It returns a carousel of candidate products from a generic demo catalogue (`mock.shop`); clicking a card creates that product as a **draft** in the store.

**It cannot:** build or apply themes, create products programmatically, configure store settings, manage apps, or access the Admin API.

**Practical use:** getting placeholder products into the store in minutes. It will **not** return Indian personal-care SKUs carrying the `replenishment_days` metafield or concern tags required by §3.2 — so the seed script remains mandatory regardless.

#### 4.4.4 Responsibility matrix

| Task | Mechanism | Owner |
|---|---|---|
| Store creation | Partner dashboard | Developer |
| Store settings (§4.1) | Admin UI — **manual, ~20 min** | Developer |
| Theme scaffold & push | Shopify CLI | Developer |
| Theme customisation code | Written as Liquid/CSS files | Assistant |
| Event-tracking snippet (§7) | Written, then `theme push` | Assistant → Developer |
| App scaffold & tunnel | Shopify CLI | Developer |
| Webhook handler code | Next.js route handler | Assistant |
| Product catalogue (§3) | Admin GraphQL seed script | Assistant writes, Developer runs |
| Shopify order/customer seeding | Admin GraphQL seed script | Assistant writes, Developer runs |
| Supabase bulk seeding | Direct DB seed script | Assistant writes, Developer runs |
| Discount codes | Admin UI or API | Either |

> **The manual block is small and fixed:** store creation, the §4.1 settings, and running CLI commands. Everything else is generated code. Budget one focused hour for the manual portion and do it before any seeding begins — §4.1 settings changed after seeding require re-seeding.

---

## 5. Data seeding strategy

### 5.1 The constraint

Shopify's `orderCreate` mutation is capped at **5 orders per minute** on development and trial stores. A 3,000-order history would take roughly 10 hours of rate-limited scripting.

### 5.2 Resolution — hybrid seeding

| Target | Volume | Method | Purpose |
|---|---|---|---|
| Supabase (CRM store) | 800 customers, ~3,000 orders, 18 months | Direct DB insert via seed script | Analytical depth: RFM, churn, cohorts, LTV |
| Shopify | 12 products, ~40 customers, ~80 orders | Admin GraphQL API | Integration proof: OAuth, webhooks, live sync |

**Rationale:** Nobody will audit whether all 3,000 rows travelled through the Shopify API. They will ask whether the integration works — and that needs one live order, not three thousand.

### 5.3 Synthetic data requirements

The seed script must **deliberately manufacture** the cohorts the CRM needs to detect. Random data produces a uniform blob and every AI feature returns nothing interesting.

Required cohorts:

| Cohort | Share | Definition |
|---|---|---|
| Champions | 12% | 5+ orders, last order < 30 days, high AOV |
| Loyal | 18% | 3–5 orders, regular cadence |
| Promising | 15% | 2 orders, recent, cadence not yet established |
| At Risk | 20% | 3+ orders, silent for 2–3× their own median gap |
| Hibernating | 20% | 2+ orders, silent 180+ days |
| One-and-done | 15% | Single order, 90+ days ago |

Additional realism requirements:
- **Per-customer purchase cadence** drawn from a distribution, not a fixed interval — churn detection must compare a customer against *their own* rhythm, not a global average
- Indian names, cities weighted toward metros with a real tail of tier-2/3
- Seasonal variation (festive uplift around Oct–Nov)
- ~15% of customers with zero phone number, to force the identity-resolution edge case
- Mixed consent states, so consent-gating is demonstrable
- Abandoned checkouts at roughly 3× the completed-order rate

### 5.4 Backdating

`processedAt` must be set explicitly on every seeded order. If every order carries today's date, every customer scores as a Champion and the entire segmentation demo collapses. This is the single most common seeding failure.

---

## 6. Integration surface

### 6.1 The CRM app

Scaffolded via `shopify app init` (see §4.4.2), authenticated with an **offline access token** — `orderCreate` requires this and will not work with session tokens.

**Scopes:** `read_products`, `write_products`, `read_customers`, `write_customers`, `read_orders`, `write_orders`, `read_checkouts`, `read_discounts`

**Protected customer data:** consent must be declared in app config. Orders and customers are protected data; skipping this returns null fields with no obvious error.

### 6.2 Webhook subscriptions

| Topic | CRM consequence |
|---|---|
| `orders/create` | New order → recompute RFM, fire post-purchase flow |
| `orders/updated` | Status change → update timeline |
| `orders/cancelled` | Reverse scoring contribution |
| `customers/create` | New profile, identity stitch on phone |
| `customers/update` | Consent and contact changes |
| `checkouts/create` | Abandonment timer starts |
| `checkouts/update` | Abandonment timer resets |

### 6.3 Webhook contract requirements

These are hard requirements on the receiving endpoint (specified in PRD 02, §7):

1. **HMAC verification against the raw request body**, not parsed JSON
2. **Return 200 within 5 seconds** — Shopify retries otherwise; queue all real work
3. **Idempotent upserts** keyed on `shopify_order_id` (unique constraint) — retries will deliver duplicates
4. **Log every received webhook** before processing, for replay and debugging

### 6.4 Local development

Shopify cannot reach `localhost`. **Use `shopify app dev`** — it manages the tunnel and re-registers all seven webhook subscriptions against the current URL on every start (§4.4.1).

ngrok works as a fallback but requires manually updating webhook URLs after every restart. Budget an hour for first-time CLI and Partner-account setup rather than discovering the tunnel problem at 2am.

---

## 7. Event instrumentation

Orders alone are insufficient — the CRM's browse-abandonment and engagement features need pre-purchase signal.

**Minimum viable instrumentation:** a lightweight script in the theme posting to the CRM's event endpoint:

- `page_view` (with product ID on PDPs)
- `product_view`
- `add_to_cart`
- `checkout_started`

**Fallback:** if theme instrumentation proves fiddly, a standalone "demo event emitter" page in the CRM app that fires the same events. Deterministic, demo-safe, and honest — label it as a simulator.

---

## 8. Build sequence

Ordered by dependency. Steps 1–2 are hard blockers — nothing else can start until they clear.

| # | Step | Owner | Gate |
|---|---|---|---|
| 1 | Partner account + CLI install + `shopify auth login` | Developer | `shopify` commands authenticate |
| 2 | Create development store | Developer | Store accessible |
| 3 | **All §4.1 settings, including required phone field** | Developer | Verified before any seeding |
| 4 | `shopify app init` — scaffold CRM app, declare scopes and protected-data consent | Developer | App installs on store |
| 5 | Webhook handler endpoint (PRD 02 §F1) | Assistant → Developer | Returns 200, verifies HMAC |
| 6 | `shopify app dev` — tunnel up, 7 topics registered | Developer | Test webhook received |
| 7 | Product catalogue seed script (§3) | Assistant → Developer | 12 products with metafields live |
| 8 | `shopify theme init` + branding + tracking snippet + `push` | Both | Storefront presentable, events firing |
| 9 | Shopify customer/order seed (~40/~80, backdated) | Assistant → Developer | Orders visible in admin with correct dates |
| 10 | Supabase bulk seed (800/3,000, 18 months) | Assistant → Developer | Cohort distribution matches §5.3 |
| 11 | Discount codes | Developer | Redeemable at checkout |
| 12 | End-to-end verification | Developer | §9 acceptance criteria pass |

> **Step 3 before step 9 is the ordering that matters most.** Checkout settings changed after seeding require a full re-seed.

---

## 9. Acceptance criteria

The storefront is done when:

- [ ] Shopify CLI installed, authenticated, Partner account created
- [ ] Theme scaffolded via `shopify theme init`, branded, and pushed
- [ ] 12 products live across 3 collections, with variants, tags, and `replenishment_days` metafields
- [ ] Phone number is required at checkout and stored in E.164
- [ ] Consent checkboxes present for email and WhatsApp
- [ ] CRM app scaffolded via `shopify app init`, installed with all scopes and protected-data consent granted
- [ ] `shopify app dev` starts cleanly and auto-registers webhooks
- [ ] All 7 webhook topics registered and confirmed delivering to the CRM endpoint
- [ ] ~40 customers and ~80 orders seeded via API, spanning at least 6 months
- [ ] A manually placed test order appears in the CRM within 5 seconds
- [ ] An abandoned checkout appears in the CRM's abandonment queue
- [ ] Three discount codes created and redeemable

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 5 orders/min cap misjudged | Seeding takes hours | Hybrid strategy — Shopify holds only ~80 orders |
| Phone field not required | WhatsApp layer has no join key | Configure and verify before any seeding |
| Orders created without backdating | Segmentation demo is meaningless | Set `processedAt` explicitly; verify RFM spread post-seed |
| Protected-data consent not granted | Customer fields return null | Declare in app config at creation |
| Theme instrumentation blocked | No browse events | Fall back to the in-app event simulator |
| Partner account / CLI auth delays | Blocks app scaffold and tunnel | Set up CLI and Partner account on day 1, before any build work |
| Settings changed after seeding | Requires full re-seed | Complete all §4.1 settings before the first seed run |
| MCP connector assumed more capable than it is | Planning built on absent capability | §4.4.3 — one tool only; seed script is the real mechanism |
| Store deleted / dev store expiry | Total loss before demo | Keep the seed script idempotent and re-runnable; Supabase is the durable store |
