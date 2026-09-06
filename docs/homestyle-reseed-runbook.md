# HomeStyle reseed runbook

The code rebrand from Rasaya (Ayurvedic skincare) to **HomeStyle Furniture** is
complete and green. What remains is repopulating the Shopify store and the
database, which is blocked on one credential.

Everything below is safe to stop half-way through: nothing is destroyed until
step 5, and step 5 refuses to run until step 3 has happened.

---

## Blocker

`.env.local` has `SHOPIFY_STORE_DOMAIN` and `SHOPIFY_API_SECRET` but **no
`SHOPIFY_ADMIN_TOKEN`**, so every script that talks to the Admin API fails
immediately:

```
$ node --import tsx scripts/verify-shopify-token.mjs
Missing in .env.local: SHOPIFY_ADMIN_TOKEN
```

Add it, then work through the steps in order.

```
SHOPIFY_ADMIN_TOKEN=shpat_...
```

Connect WARP before anything that touches Postgres — the campus firewall blocks
5432/6543 otherwise.

---

## Steps

### 0. Confirm the token and the store

```bash
node --import tsx scripts/verify-shopify-token.mjs
```

Check the shop it reports is the store you intend to rebuild.
`.env.local` currently points at `8b2cwk-h7.myshopify.com`.

### 1. Push the catalogue

```bash
node --import tsx scripts/seed-catalogue.mjs
node --import tsx scripts/verify-catalogue.mjs
```

Creates 4 collections (`living-room`, `bedroom`, `dining`, `care-decor`) and 15
products. Idempotent — matched by handle and updated in place.

Products seed **without images**: `data/catalogue.json` ships every
`image_url` empty, because furniture photography has to be supplied rather than
generated. Products will read `NO IMG` in the script output. To attach photos,
put a URL in each product's `image_url`, run
`node --import tsx scripts/download-images.mjs`, and re-run this step.

### 2. Discount codes

```bash
node --import tsx scripts/seed-discounts.mjs
```

`WELCOME10 · COMEBACK15 · COMPLETE20 · WINBACK15 · HOMESTYLE5 · FESTIVE20 · DIWALI15`
(`REFILL20` became `COMPLETE20` — "complete the room" is the furniture
equivalent of a refill nudge, and `RASAYA5` became `HOMESTYLE5`.)

### 3. Capture the real Shopify ids

```bash
npm run capture-ids          # or: --dry-run to see what it would write
```

**This is the step that unblocks step 5.** `data/shopify-ids.json` currently
holds *placeholder* ids, generated so the seed generator could be validated
offline, and is marked `"_provisional": true`. `seed-supabase.mjs` refuses to
write to the database while that flag is present, because placeholder ids
produce a database that looks healthy and silently matches zero live webhooks.

The previous Rasaya map is preserved at `data/shopify-ids.rasaya.bak.json`;
delete it once you no longer want it.

### 4. Backdated storefront orders (optional)

```bash
node --import tsx scripts/seed-shopify.mjs
```

`data/shopify-seed.json` still contains the **old Rasaya SKUs** and needs
rewriting against the new catalogue before this will do anything useful. Skip
it unless you specifically want real orders on the storefront — the CRM's
analytical dataset comes from step 5, not from here.

Per the store's history, backdated orders only work via
`shopify app execute` against a dev store.

### 5. Reseed the database — **destructive, irreversible**

```bash
npm run seed -- --truncate
```

`--truncate` is required, not optional: the generator's row shape changed, so a
plain upsert leaves surplus rows from the previous generator and the script's
own verification fails loudly rather than leaving a quietly wrong dataset.

This **permanently destroys** the current Rasaya dataset:

| table | before | after (approx) |
|---|---|---|
| customers | 800 | 800 |
| orders | 2,780 | 2,704 |
| order_items | 5,415 | 4,005 |
| events | 52,204 | 49,286 |
| consents | 1,857 | 1,851 |
| products | 12 | 15 |

The run prints its own evidence and fails if any of it is wrong — cohort counts
against target, the cadence spread, and the two-tier assertion that **no
furniture piece is ever bought twice by the same customer**.

### 6. Score

```bash
npm run score
```

Runs `db/scoring.sql`, which is already validated against the live schema
(`EXPLAIN` passes). Re-runnable; two runs minutes apart produce identical rows.

### 7. Refresh the room view

```bash
npm run apply-room-view
```

`v_room_completion` is **already created and granted** to `cadence_agent`, and
currently returns 0 rows because the products table has no room collections
yet. Re-running after the reseed reports the populated shape. Only strictly
necessary if `db/views-room.sql` changed.

---

## Verify

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run dev     # then open /rooms
```

`/rooms` should show three room tiles, a board sorted by value still missing,
and an attach-rate table underneath. Ask Cadence should answer
*"which living rooms are one piece away from complete?"*.

---

## What is already done

- `data/catalogue.json` — 15 products, two tiers, per-product option names
- `db/scoring.sql` — tier-aware medians, tier-aware silence floors, rewritten reasons
- `db/views-room.sql` + `v_room_completion` — **applied to the live database**
- `scripts/seed-supabase.mjs` — two-tier generator, room projects drawn without replacement
- `app/rooms` + `lib/queries-rooms.ts` + Customer 360 rooms panel
- `lib/agent/prompt.ts` / `views.ts` — five views, 14 few-shot examples, tier-aware methodology
- `DESIGN.md` + `app/globals.css` — the warm palette, structure unchanged
- `homestyle-theme/` — renamed from `rasaya-theme/`, palette realigned, serif display face
- All tests, fixtures and golden HMAC digests updated

## Known leftovers

- `data/shopify-seed.json` — still Rasaya SKUs (input to step 4 only)
- `data/images/*.png` — 12 stale Rasaya product renders, now referenced by nothing
- `data/seed-shopify.log` — a log from the old store
- The four original agent views still have no definition in the repo; only
  `v_room_completion` does
