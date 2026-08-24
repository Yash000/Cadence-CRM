// Bulk analytical seed for the Cadence CRM database (Task 3, PRD-01 §5.3–§5.4).
//
//   npm run seed              # seed (idempotent upsert)
//   npm run seed -- --dry-run # generate + verify in memory, write nothing
//   npm run seed -- --truncate
//
// (or directly: node --import tsx scripts/seed-supabase.mjs [flags])
//
// WHY THIS SCRIPT IS SHAPED THE WAY IT IS
// ---------------------------------------
// PRD-01 §5.3 is blunt that randomly generated commerce data "produces a
// uniform blob and every AI feature returns nothing interesting". Two design
// rules follow, and everything below exists to serve them:
//
//  1. Every customer gets their OWN purchase cadence, drawn from a
//     distribution, never a global interval. Churn detection (PRD-02 §F3.2)
//     compares a customer against their own median inter-purchase gap, so if
//     everyone repurchased every 45 days there would be nothing to detect and
//     the product thesis would be unfalsifiable. "At Risk" here means silent
//     for 2–3× *that customer's* median gap, not silent past a global cutoff.
//
//  2. `processed_at` is set explicitly on every order and spread over 18
//     months. PRD-01 §5.4 calls undated orders the single most common seeding
//     failure: if every order carries today's date, every customer scores as a
//     Champion and segmentation collapses into one bar.
//
// DETERMINISM / IDEMPOTENCY
// -------------------------
// A seeded PRNG (mulberry32) drives every choice, and every row's primary key
// is a UUIDv5 derived from the seed plus a stable logical key ("customer:417",
// "order:417:2"). So a re-run regenerates byte-identical rows with identical
// UUIDs and every insert is an upsert on the primary key — no duplicates, and
// foreign keys written by later tasks (customer_scores.customer_id) survive a
// re-seed. Changing --seed produces a completely different, equally
// deterministic dataset under different UUIDs.
//
// The one case upsert cannot cover is a change to the generator itself: if a
// new version emits fewer order_items or events per order, the previous run's
// surplus rows are still in the table under keys nothing regenerates. The
// verification below compares generated counts against database counts and
// fails loudly telling you to re-run with --truncate, rather than leaving a
// quietly wrong dataset behind.
//
// MONEY
// -----
// Money columns are numeric(12,2) and Drizzle returns them as strings (Task 1
// chose string mode deliberately). All arithmetic here is in integer paise and
// only converted to a decimal string at the moment of insert. There is no
// parseFloat in this file, on purpose.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sql, inArray } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Environment — .env.local is owned by the controller; this only reads it.
// Same minimal reader as scripts/verify-agent-role.mjs (split on /\r?\n/ so a
// CRLF file does not leave a trailing \r inside the value).
// ---------------------------------------------------------------------------
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const DRY_RUN = flag('dry-run');
const TRUNCATE = flag('truncate');
const SEED = Number(opt('seed', '20260824'));
const CUSTOMER_COUNT = Number(opt('customers', '800'));

// Fixed anchor "now". Deliberately a constant and not Date.now(): the whole
// dataset is positioned relative to it, so a floating anchor would make
// re-runs differ and would slowly drift customers across cohort boundaries.
const ANCHOR = new Date('2026-08-24T09:00:00.000Z');
const ANCHOR_MS = ANCHOR.getTime();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const WINDOW_DAYS = 540; // 18 months
const MAX_SPAN_DAYS = WINDOW_DAYS - 6; // leave headroom for hour-level jitter
// The catalogue is older than the order window — a store's products exist
// before its first order. Fixed so products.created_at/updated_at are
// reproducible rather than now().
const CATALOGUE_EPOCH = new Date(ANCHOR_MS - (WINDOW_DAYS + 30) * DAY);

// Every seeded Indian mobile: +91 then ten digits starting 6–9. Asserted after
// the write — the DB's own CHECK is the generic E.164 shape and cannot catch a
// short national number.
const PHONE_PATTERN = '^\\+91[6-9][0-9]{9}$';

// Synthetic Shopify id ranges. Deliberately far above any id the live store
// will mint (real Rasaya product ids are ~1.04e13), so a future webhook sync of
// genuine Shopify customers/orders can never collide with seeded rows and the
// seeded rows stay trivially identifiable.
const CUSTOMER_ID_BASE = 900_000_000_000_000;
const ORDER_ID_BASE = 900_000_000_000_000;

// AOV (in paise) above which a frequent, recent buyer counts as a Champion.
const CHAMPION_AOV_PAISE = 200_000; // ₹2,000

// ---------------------------------------------------------------------------
// Deterministic PRNG + helpers
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

const randInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const uniform = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

/** Weighted pick from [[value, weight], ...]. */
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

/** Box–Muller, driven by the same seeded stream. */
function normal(mean, sd) {
  const u = Math.max(rnd(), 1e-12);
  const v = rnd();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// UUIDv5 over a namespace derived from the seed, so ids are stable across runs
// and disjoint across seeds.
const NAMESPACE = createHash('sha1').update(`cadence-seed:${SEED}`).digest().subarray(0, 16);
function uuid5(name) {
  const h = createHash('sha1').update(NAMESPACE).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Money — integer paise in, decimal string out. No floats anywhere.
// ---------------------------------------------------------------------------
function toPaise(decimalString) {
  const [rupees, frac = ''] = String(decimalString).trim().split('.');
  const paise = (frac + '00').slice(0, 2);
  return Number(rupees) * 100 + Number(paise);
}
function toDecimal(paise) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Catalogue — the real 12 products, with the live store's product/variant ids.
// ---------------------------------------------------------------------------
const catalogue = JSON.parse(readFileSync(new URL('../data/catalogue.json', import.meta.url), 'utf8'));
const shopifyIds = JSON.parse(readFileSync(new URL('../data/shopify-ids.json', import.meta.url), 'utf8'));
const idsByHandle = new Map(shopifyIds.products.map((p) => [p.handle, p]));

const PRODUCTS = catalogue.products.map((p, i) => {
  const live = idsByHandle.get(p.handle);
  if (!live) throw new Error(`data/shopify-ids.json has no entry for handle "${p.handle}" — regenerate it (see its _note).`);
  const variants = p.variants.map((v) => {
    const liveV = live.variants.find((lv) => lv.sku === v.sku);
    if (!liveV) throw new Error(`no live variant for sku ${v.sku}`);
    return {
      sku: v.sku,
      title: v.title,
      pricePaise: toPaise(v.price),
      replenishmentDays: v.replenishment_days,
      shopifyVariantId: liveV.shopify_variant_id,
    };
  });
  return {
    idx: i,
    id: uuid5(`product:${p.handle}`),
    handle: p.handle,
    title: p.title,
    collection: p.collection,
    role: p.role,
    tags: p.tags,
    replenishmentDays: p.replenishment_days,
    shopifyProductId: live.shopify_product_id,
    // products.price is the "from" price — the cheapest variant, which is what
    // a storefront card shows and what a coarse LTV heuristic should read.
    pricePaise: Math.min(...variants.map((v) => v.pricePaise)),
    variants,
  };
});

const BY_COLLECTION = {};
for (const p of PRODUCTS) (BY_COLLECTION[p.collection] ??= []).push(p);
const COLLECTIONS = Object.keys(BY_COLLECTION);

// ---------------------------------------------------------------------------
// Cohort plan — PRD-01 §5.3. Shares must sum to 1.
// ---------------------------------------------------------------------------
const COHORTS = [
  { key: 'champions', label: 'Champions', share: 0.12 },
  { key: 'loyal', label: 'Loyal', share: 0.18 },
  { key: 'promising', label: 'Promising', share: 0.15 },
  { key: 'at_risk', label: 'At Risk', share: 0.2 },
  { key: 'hibernating', label: 'Hibernating', share: 0.2 },
  { key: 'one_and_done', label: 'One-and-done', share: 0.15 },
];

/** Largest-remainder apportionment so the counts sum to CUSTOMER_COUNT exactly. */
function apportion(total, cohorts) {
  const raw = cohorts.map((c) => total * c.share);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; left > 0; k++, left--) base[order[k % order.length].i]++;
  return base;
}
const COHORT_COUNTS = apportion(CUSTOMER_COUNT, COHORTS);

/**
 * Per-cohort behaviour draw: how many orders, that customer's own median
 * cadence, and how long they have been silent.
 *
 * `silenceFor` is a function of the customer's REALIZED median gap, not of the
 * nominal cadence. That distinction is the whole point: gap jitter means the
 * realized median can sit up to ~28% above the cadence the customer was drawn
 * with, and "At Risk" is defined as 2–3× the customer's own median — so
 * deriving silence from the nominal cadence lets At Risk customers quietly
 * fail their own definition. It closes over its random draw so re-evaluating
 * it after the chain is compressed is stable rather than a fresh dice roll.
 *
 * Margins are deliberate: every boundary (30 / 90 / 180 days, 2× median) is
 * cleared by at least ~3 days so that the hour-level timestamp jitter added
 * later can never flip a customer into a neighbouring cohort.
 */
function drawBehaviour(cohortKey, replenishmentBasis, unitsPerPurchase) {
  const u = rnd();
  const between = (lo, hi) => lo + Math.floor(u * (Math.max(lo, hi) - lo + 1));

  // ---- where the cadence actually comes from -------------------------------
  // The customer's rhythm starts from the replenishment cycle of the variant
  // they habitually buy (30–75 days across this catalogue: 30 for Triphala or
  // 60-count gummies, 75 for a 200ml hair oil), multiplied by how many units
  // they take at a time, then by a personal factor for how heavily that
  // individual uses it.
  //
  // The units term is the one that legitimately produces the long tail: someone
  // who buys two bottles of a 60-day product per order is on a ~120-day rhythm
  // for an entirely mechanical reason, and the same propensity drives their
  // basket quantities below, so the data and the explanation agree. Widening
  // the random `personal` term instead would have hit the same percentile
  // targets while making the spread LESS attributable to the catalogue, which
  // is the opposite of what this change is for.
  //
  // Two people buying the same 45-day hair oil still genuinely differ — one is
  // oiling twice a week, one is not — but a Triphala buyer and a 200ml
  // hair-oil buyer differ structurally, and that reason is in the catalogue
  // rather than in a random number.
  //
  // This replaced a per-cohort random draw whose clamps (18–40, 38–72, 20–58…)
  // were what actually squeezed the population into a 2.6× spread. Cohort
  // clamps still exist below, but now only where the cohort DEFINITION forces
  // them — e.g. At Risk cannot exceed ~85 days because 2× its own median must
  // still land under the 180-day Hibernating line. Those are consequences of
  // PRD-01 §5.3, not tuning knobs.
  // Centred at 0.82, not 1.0: a catalogue's `replenishment_days` is a
  // conservative "lasts up to N days" claim, and real users finish a bottle
  // somewhat sooner than the label promises.
  const personal = Math.min(3.4, Math.max(0.40, 0.82 * Math.exp(normal(0, 0.62))));
  const base = replenishmentBasis * unitsPerPurchase * personal;
  const clamp = (lo, hi) => Math.max(lo, Math.min(hi, Math.round(base)));

  // How many orders of cadence `m` fit in the window once `silence` is spent.
  const fits = (m, silence, cap) =>
    Math.max(2, Math.min(cap, 1 + Math.floor((MAX_SPAN_DAYS - silence) / (m * 1.3))));

  switch (cohortKey) {
    case 'champions': {
      // Upper clamp is arithmetic, not taste: five orders inside 18 months is
      // impossible above ~95 days, and Champions need 5+.
      const cadence = clamp(14, 95);
      const n = randInt(5, Math.max(5, fits(cadence, 30, 10)));
      // recent (<30d) and comfortably inside 2× their own gap
      return { n, cadence, silenceFor: (m) => between(4, Math.min(26, Math.floor(2 * m) - 4)) };
    }
    case 'loyal': {
      // Floor of 30: silence must clear 33 days (never a Champion) while
      // staying under 2× their own median, which needs a median above ~21 —
      // and jitter can pull a 21-day cadence down to 16.
      const cadence = clamp(30, 180);
      const n = randInt(3, Math.max(3, fits(cadence, 40, 5)));
      // ≥30d silent (so never a Champion) but well below 2× their own gap
      return { n, cadence, silenceFor: (m) => between(33, Math.min(84, Math.floor(2 * m) - 8)) };
    }
    case 'promising': {
      // A single gap, so this cohort carries the long tail of the catalogue —
      // the twice-a-year SPF buyer lives here.
      return { n: 2, cadence: clamp(12, 340), silenceFor: () => between(6, 84) };
    }
    case 'at_risk': {
      // Definition-bound, and the bound is tight: silence must reach 2× their
      // own median AND stay under the 180-day Hibernating line. With jitter
      // able to lift the realized median to 1.28× the cadence, 2×1.28×c + 3
      // must stay under 175, so c cannot exceed ~66. An At Risk customer with
      // a 90-day rhythm is not a data choice this seed can make — by PRD-01
      // §5.3's own definitions such a person is Hibernating before they are
      // ever 2× overdue.
      const cadence = clamp(15, 66);
      const n = randInt(3, Math.max(3, fits(cadence, Math.min(175, cadence * 2.6), 7)));
      return {
        n,
        cadence,
        // 2–3× their OWN median, floored just above 2× so jitter cannot undo it
        silenceFor: (m) => Math.min(175, Math.max(Math.floor(2 * m) + 3, Math.round(m * (2.25 + u * 0.6)))),
      };
    }
    case 'hibernating': {
      // Needs 182+ days of silence AND at least one gap inside the window, so
      // the cadence ceiling falls out of (540 − 182) rather than being chosen.
      const cadence = clamp(15, 265);
      const silence = between(182, Math.min(400, Math.floor(MAX_SPAN_DAYS - 1.3 * cadence)));
      const n = randInt(2, fits(cadence, silence, 5));
      return { n, cadence, silenceFor: () => silence };
    }
    case 'one_and_done': {
      return { n: 1, cadence: null, silenceFor: () => between(92, 520) };
    }
    default:
      throw new Error(`unknown cohort ${cohortKey}`);
  }
}

// ---------------------------------------------------------------------------
// Seasonality — festive uplift (Navratri → Diwali → early Nov), PRD-01 §5.3.
// The window spans Mar 2025 → Aug 2026, so it contains one full festive season
// (Oct–Nov 2025). Uplift is applied two ways that both preserve each
// customer's order count (so cohorts stay intact):
//   · date warping — an order that would have landed just outside the season
//     is pulled into it half the time, which is what a real promo calendar
//     does to purchase timing;
//   · basket uplift — festive orders carry more units and a festive discount.
// ---------------------------------------------------------------------------
const FESTIVE_WINDOWS = [
  // [inclusive start, inclusive end] as UTC dates
  [Date.UTC(2025, 8, 26), Date.UTC(2025, 10, 25)], // 26 Sep – 25 Nov 2025
];
const isFestive = (ms) => FESTIVE_WINDOWS.some(([a, b]) => ms >= a && ms <= b);

/** Pull a timestamp into the festive window when it lands just outside it. */
function warpToFestive(ms) {
  for (const [a, b] of FESTIVE_WINDOWS) {
    if (ms > b && ms - b <= 22 * DAY && chance(0.5)) return b - Math.floor(rnd() * 18 * DAY);
    if (ms < a && a - ms <= 22 * DAY && chance(0.5)) return a + Math.floor(rnd() * 18 * DAY);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Reyansh', 'Arjun', 'Ishaan', 'Kabir', 'Rohan', 'Dhruv', 'Karthik',
  'Rahul', 'Nikhil', 'Siddharth', 'Aniket', 'Varun', 'Manav', 'Yash', 'Harsh', 'Devansh', 'Tanmay',
  'Ananya', 'Diya', 'Aadhya', 'Saanvi', 'Ishita', 'Meera', 'Riya', 'Neha', 'Priya', 'Kavya',
  'Anjali', 'Shreya', 'Nandini', 'Sneha', 'Pooja', 'Tanvi', 'Aditi', 'Lakshmi', 'Radhika', 'Simran',
];
const LAST_NAMES = [
  'Sharma', 'Verma', 'Iyer', 'Menon', 'Nair', 'Reddy', 'Rao', 'Kulkarni', 'Deshpande', 'Joshi',
  'Patel', 'Shah', 'Gupta', 'Agarwal', 'Bose', 'Chatterjee', 'Banerjee', 'Mukherjee', 'Pillai', 'Krishnan',
  'Singh', 'Chauhan', 'Malhotra', 'Kapoor', 'Bhatt', 'Trivedi', 'Naidu', 'Sethi', 'Ghosh', 'Dutta',
];
const PLACES = [
  ['Mumbai', 'Maharashtra'], ['Pune', 'Maharashtra'], ['Nagpur', 'Maharashtra'],
  ['Bengaluru', 'Karnataka'], ['Mysuru', 'Karnataka'],
  ['Chennai', 'Tamil Nadu'], ['Coimbatore', 'Tamil Nadu'],
  ['Hyderabad', 'Telangana'], ['Visakhapatnam', 'Andhra Pradesh'],
  ['Delhi', 'Delhi'], ['Gurugram', 'Haryana'], ['Noida', 'Uttar Pradesh'], ['Lucknow', 'Uttar Pradesh'],
  ['Jaipur', 'Rajasthan'], ['Ahmedabad', 'Gujarat'], ['Surat', 'Gujarat'],
  ['Kolkata', 'West Bengal'], ['Bhubaneswar', 'Odisha'], ['Indore', 'Madhya Pradesh'],
  ['Kochi', 'Kerala'], ['Thiruvananthapuram', 'Kerala'], ['Chandigarh', 'Chandigarh'],
];

const DISCOUNTS = [
  { code: 'FESTIVE20', pct: 20, festiveOnly: true },
  { code: 'DIWALI15', pct: 15, festiveOnly: true },
  { code: 'WELCOME10', pct: 10, festiveOnly: false },
  { code: 'WINBACK15', pct: 15, festiveOnly: false },
  { code: 'RASAYA5', pct: 5, festiveOnly: false },
];

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
function buildBasket(customer, { festive, champion }) {
  const lines = [];
  const wantedLines = champion ? randInt(2, 4) : weighted([[1, 58], [2, 27], [3, 11], [4, 4]]);

  const candidates = [];
  // Bias hard toward the customer's own collection so repeat purchases repeat
  // the same products — replenishment prediction (§F3.4) has nothing to work
  // with if every order is a random draw from all 12 SKUs.
  for (const p of BY_COLLECTION[customer.collection]) candidates.push([p, 6]);
  for (const p of PRODUCTS) if (p.collection !== customer.collection) candidates.push([p, 1]);

  const chosen = new Set();
  if (chance(0.72)) chosen.add(customer.favourite);
  while (chosen.size < wantedLines) chosen.add(weighted(candidates));

  for (const product of chosen) {
    // On their staple product they mostly re-buy the same size. That matters:
    // the customer's cadence was derived from that variant's replenishment
    // cycle, so if they kept switching between the 100ml and the 200ml the
    // rhythm in the data would not match the rhythm in the catalogue.
    const variant = product === customer.favourite && chance(0.8)
      ? customer.favouriteVariant
      : product.variants.length === 1
        ? product.variants[0]
        : weighted(product.variants.map((v, i) => [v, i === 0 ? 6 : 4]));
    // Their staple comes in their usual stock-up size — the same propensity
    // the cadence was built from. Everything else is an ordinary single unit.
    let qty = product === customer.favourite
      ? customer.unitsPerPurchase
      : weighted([[1, 84], [2, 13], [3, 3]]);
    if (festive && chance(0.5)) qty += 1;
    lines.push({ product, variant, qty });
  }
  return lines;
}

function subtotalOf(lines) {
  return lines.reduce((sum, l) => sum + l.variant.pricePaise * l.qty, 0);
}

function generate() {
  const customers = [];
  const orders = [];
  const orderItems = [];
  const consents = [];
  const events = [];

  let customerIdx = 0;
  let orderSeq = 0;
  let eventSeq = 0;
  // How many customers needed more than one draw to land in their cohort. A
  // high number would mean the retry loop is filtering the cadence
  // distribution toward "easy" draws, so it is reported rather than hidden.
  let redraws = 0;

  for (let c = 0; c < COHORTS.length; c++) {
    const cohort = COHORTS[c];
    for (let k = 0; k < COHORT_COUNTS[c]; k++) {
      const idx = customerIdx++;
      const key = `customer:${idx}`;
      const id = uuid5(key);

      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const [city, state] = pick(PLACES);
      // ~15% carry no phone at all — this is what forces the identity
      // resolution edge case in PRD-02 §F1.5 (email-only customers that a
      // WhatsApp-first CRM cannot reach or match on).
      const hasPhone = !chance(0.15);
      const collection = weighted([['hair-care', 40], ['skin-care', 40], ['wellness', 20]]);
      const favourite = pick(BY_COLLECTION[collection]);
      // The staple SKU, down to the size. Its replenishment_days is what the
      // customer's purchase rhythm is built from below — a 30-day Triphala
      // buyer and a 75-day 200ml-hair-oil buyer should not share a cadence.
      const favouriteVariant = pick(favourite.variants);
      // How many units of their staple they take per order. Feeds BOTH the
      // cadence basis and the basket quantities below, so a customer who
      // stocks up two at a time genuinely reappears half as often.
      const unitsPerPurchase = weighted([[1, 70], [2, 21], [3, 9]]);

      const customer = {
        id,
        idx,
        cohort: cohort.key,
        shopifyCustomerId: CUSTOMER_ID_BASE + idx,
        email: `${first}.${last}${idx}@cadence-bulk.test`.toLowerCase(),
        // +91 followed by TEN digits starting 6–9. The DB CHECK is the generic
        // E.164 shape (^\+[1-9][0-9]{7,14}$), which a 9-digit Indian number
        // also satisfies — so the constraint cannot catch this and the seed
        // must get it right itself. PRD-01 §4.1 makes phone_e164 the join key
        // between Shopify identity and WhatsApp identity: a short number is
        // rejected outright by the WhatsApp Cloud API and can never match a
        // genuine `customers/update` webhook. Asserted after the write below.
        phoneE164: hasPhone ? `+919${800_000_000 + idx}` : null,
        firstName: first,
        lastName: last,
        city,
        state,
        country: 'IN',
        collection,
        favourite,
        favouriteVariant,
        unitsPerPurchase,
      };

      // ---- cadence + order chain -----------------------------------------
      // The cohort a chain lands in is decided by the REALIZED timestamps, and
      // gap jitter plus the festive warp can push a draw across a boundary.
      // Rather than hand-proving that every bound in drawBehaviour is immune to
      // that — which is what broke the first time — redraw and re-check. The
      // draws come off the same seeded stream, so this stays deterministic, and
      // it degrades loudly (throw) instead of silently misclassifying.
      const chainCohort = (chain) => {
        const times = [...chain].map((x) => x.ms).sort((a, b) => a - b);
        const g = times.slice(1).map((t, i) => (t - times[i]) / DAY);
        return classify({
          n: times.length,
          lastDays: (ANCHOR_MS - times[times.length - 1]) / DAY,
          medianGap: g.length ? median(g) : null,
          // AOV is settled below (champion baskets are topped up to clear the
          // threshold), so this check is purely about counts and dates.
          aovPaise: Infinity,
        });
      };

      let customerOrders = null;
      let n = 0, cadence = 0, silence = 0;
      for (let attempt = 0; attempt < 24 && !customerOrders; attempt++) {
        const drawn = drawBehaviour(cohort.key, favouriteVariant.replenishmentDays, unitsPerPurchase);
        n = drawn.n;
        cadence = drawn.cadence;
        const silenceFor = drawn.silenceFor;

        let gaps = [];
        for (let g = 0; g < n - 1; g++) {
          gaps.push(Math.max(8, Math.round(cadence * uniform(0.78, 1.28))));
        }
        silence = silenceFor(median(gaps) ?? 0);
        // Keep the whole chain inside the 18-month window; compress uniformly
        // rather than dropping orders, which would change the cohort. Silence is
        // re-derived after compression because it is a function of the median.
        for (let fit = 0; fit < 4; fit++) {
          const total = silence + gaps.reduce((a, b) => a + b, 0);
          if (total <= MAX_SPAN_DAYS || !gaps.length) break;
          const scale = Math.max(0.05, (MAX_SPAN_DAYS - silence) / (total - silence));
          gaps = gaps.map((g) => Math.max(8, Math.floor(g * scale)));
          silence = silenceFor(median(gaps));
        }

        // Walk backwards from the most recent order.
        const daysAgo = [silence];
        for (const g of gaps) daysAgo.push(daysAgo[daysAgo.length - 1] + g);
        daysAgo.reverse(); // oldest first

        // Two candidate chains: one with the festive date-warp applied to the
        // interior orders, one without. The warp shifts real gaps by up to three
        // weeks, which can move a customer's realized median enough to break
        // their cohort — so warp, re-classify, and fall back to the unwarped
        // chain if it did. Cohort integrity outranks seasonality.
        const plain = [];
        const warped = [];
        for (let o = 0; o < n; o++) {
          const ms = ANCHOR_MS - daysAgo[o] * DAY + randInt(-5, 5) * HOUR + randInt(0, 59) * MINUTE;
          plain.push({ ms, seq: o });
          // The most recent order is never warped: that would move `silence`.
          warped.push({ ms: o < n - 1 ? warpToFestive(ms) : ms, seq: o });
        }
        if (chainCohort(warped) === cohort.key) customerOrders = warped;
        else if (chainCohort(plain) === cohort.key) customerOrders = plain;
        else if (attempt === 0) redraws++;
      }
      if (!customerOrders) {
        throw new Error(`customer ${idx} (${cohort.key}): no chain landed in the cohort after 24 draws — last try n=${n}, cadence=${cadence}, silence=${silence}`);
      }
      customerOrders = [...customerOrders].sort((a, b) => a.ms - b.ms);

      let lifetimePaise = 0;
      for (const co of customerOrders) {
        const oid = uuid5(`order:${idx}:${co.seq}`);
        const festive = isFestive(co.ms);
        const isChampion = cohort.key === 'champions';
        let lines = buildBasket(customer, { festive, champion: isChampion });
        let sub = subtotalOf(lines);

        // Champions are defined by high AOV as well as frequency+recency, so
        // top the basket up until the order clears the threshold with margin.
        if (isChampion) {
          const priciest = lines.reduce((a, b) => (b.variant.pricePaise > a.variant.pricePaise ? b : a));
          while (sub - Math.floor(sub * 0.2) < CHAMPION_AOV_PAISE + 40_000) {
            priciest.qty += 1;
            sub = subtotalOf(lines);
          }
        }

        // Discounts: common in the festive window, otherwise occasional.
        let discountPaise = 0;
        const codes = [];
        const pool = DISCOUNTS.filter((d) => festive || !d.festiveOnly);
        if (chance(festive ? 0.55 : 0.14)) {
          const d = pick(pool);
          discountPaise = Math.floor((sub * d.pct) / 100);
          codes.push(d.code);
        }
        const totalPaise = sub - discountPaise;
        lifetimePaise += totalPaise;

        orders.push({
          id: oid,
          shopifyOrderId: ORDER_ID_BASE + orderSeq,
          orderNumber: `#RSY-${10001 + orderSeq}`,
          customerId: id,
          total: toDecimal(totalPaise),
          subtotal: toDecimal(sub),
          discountTotal: toDecimal(discountPaise),
          discountCodes: codes,
          currency: 'INR',
          // A small slice of real-world messiness. Deliberately no 'cancelled'
          // rows: a cancelled order is not a purchase, and silently counting
          // one would corrupt every cohort assertion below.
          financialStatus: chance(0.015) ? 'partially_refunded' : 'paid',
          processedAt: new Date(co.ms),
          createdAt: new Date(co.ms - randInt(2, 30) * MINUTE),
          updatedAt: new Date(co.ms + randInt(1, 72) * HOUR),
          _totalPaise: totalPaise,
          _lines: lines,
        });
        orderSeq++;

        lines.forEach((l, li) => {
          orderItems.push({
            id: uuid5(`item:${idx}:${co.seq}:${li}`),
            orderId: oid,
            productId: l.product.id,
            variantId: l.variant.shopifyVariantId,
            title: `${l.product.title} — ${l.variant.title}`,
            qty: l.qty,
            price: toDecimal(l.variant.pricePaise),
          });
        });

        // ---- browsing that led to the order ------------------------------
        const session = `s-${idx}-${co.seq}`;
        const push = (type, atMs, payload) => {
          events.push({
            id: uuid5(`event:${eventSeq++}`),
            customerId: id,
            sessionId: session,
            type,
            payload,
            occurredAt: new Date(atMs),
          });
        };
        const pageViews = randInt(1, 3);
        for (let v = 0; v < pageViews; v++) {
          push('page_view', co.ms - (30 - v * 4) * MINUTE - randInt(0, 120) * 1000, {
            path: pick(['/', '/collections/' + customer.collection, '/pages/routine-quiz', '/blogs/journal']),
          });
        }
        for (const l of lines.slice(0, 3)) {
          push('product_view', co.ms - randInt(12, 26) * MINUTE, {
            handle: l.product.handle, title: l.product.title, sku: l.variant.sku,
          });
        }
        for (const l of lines.slice(0, 2)) {
          push('add_to_cart', co.ms - randInt(5, 11) * MINUTE, {
            handle: l.product.handle, sku: l.variant.sku, qty: l.qty, price: toDecimal(l.variant.pricePaise),
          });
        }
        push('checkout_started', co.ms - randInt(2, 4) * MINUTE, {
          checkout_id: `chk-${idx}-${co.seq}`, value: toDecimal(totalPaise), items: lines.length,
        });
      }

      // ---- abandoned checkouts: ~3× the completed-order rate --------------
      const abandonedCount = n * 3 + (chance(0.35) ? 1 : 0);
      const firstMs = customerOrders[0].ms;
      const browseFrom = Math.max(ANCHOR_MS - WINDOW_DAYS * DAY, firstMs - 25 * DAY);
      for (let a = 0; a < abandonedCount; a++) {
        const atMs = browseFrom + Math.floor(rnd() * (ANCHOR_MS - browseFrom));
        const session = `s-${idx}-ab${a}`;
        const product = chance(0.5) ? favourite : pick(BY_COLLECTION[customer.collection]);
        const variant = pick(product.variants);
        const qty = weighted([[1, 80], [2, 20]]);
        const value = variant.pricePaise * qty;
        const push = (type, offsetMin, payload) => {
          events.push({
            id: uuid5(`event:${eventSeq++}`),
            customerId: id,
            sessionId: session,
            type,
            payload,
            occurredAt: new Date(atMs + offsetMin * MINUTE),
          });
        };
        push('product_view', 0, { handle: product.handle, title: product.title, sku: variant.sku });
        push('add_to_cart', randInt(1, 4), { handle: product.handle, sku: variant.sku, qty, price: toDecimal(variant.pricePaise) });
        push('checkout_started', randInt(5, 9), { checkout_id: `chk-ab-${idx}-${a}`, value: toDecimal(value), items: 1 });
        push('checkout_abandoned', randInt(12, 40), {
          checkout_id: `chk-ab-${idx}-${a}`,
          value: toDecimal(value),
          items: [{ handle: product.handle, sku: variant.sku, qty }],
          recovery_email_sent: chance(0.4),
        });
      }

      // ---- consents: per channel, with source + timestamp -----------------
      const createdMs = firstMs - randInt(0, 6) * DAY - randInt(1, 20) * HOUR;
      const emailStatus = weighted([['opted_in', 62], ['opted_out', 13], ['unknown', 25]]);
      const consentAt = () => new Date(createdMs + Math.floor(rnd() * (ANCHOR_MS - createdMs)));
      consents.push({
        id: uuid5(`consent:${idx}:email`),
        customerId: id,
        channel: 'email',
        status: emailStatus,
        source: weighted([['checkout', 45], ['newsletter_footer', 25], ['shopify_marketing', 20], ['csv_import', 10]]),
        updatedAt: consentAt(),
      });
      if (hasPhone && chance(0.88)) {
        consents.push({
          id: uuid5(`consent:${idx}:whatsapp`),
          customerId: id,
          channel: 'whatsapp',
          status: weighted([['opted_in', 55], ['unknown', 30], ['opted_out', 15]]),
          source: weighted([['whatsapp_optin_widget', 40], ['checkout', 30], ['support_agent', 18], ['click_to_chat_ad', 12]]),
          updatedAt: consentAt(),
        });
      }
      if (hasPhone && chance(0.7)) {
        consents.push({
          id: uuid5(`consent:${idx}:sms`),
          customerId: id,
          channel: 'sms',
          status: weighted([['opted_in', 35], ['opted_out', 25], ['unknown', 40]]),
          source: weighted([['checkout', 50], ['sms_keyword', 30], ['csv_import', 20]]),
          updatedAt: consentAt(),
        });
      }

      customers.push({
        id,
        shopifyCustomerId: customer.shopifyCustomerId,
        email: customer.email,
        phoneE164: customer.phoneE164,
        firstName: first,
        lastName: last,
        city,
        state,
        country: 'IN',
        acceptsMarketing: emailStatus === 'opted_in',
        createdAt: new Date(createdMs),
        updatedAt: new Date(customerOrders[customerOrders.length - 1].ms),
        _cohort: cohort.key,
        _orders: customerOrders.length,
        _lifetimePaise: lifetimePaise,
      });
    }
  }

  return { customers, orders, orderItems, consents, events, redraws };
}

// ---------------------------------------------------------------------------
// Classification — the single definition of a cohort, applied identically here
// and in the SQL verification below. Order of the checks IS the definition.
// ---------------------------------------------------------------------------
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  // Matches Postgres percentile_cont(0.5): interpolate for even counts.
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function classify({ n, lastDays, medianGap, aovPaise }) {
  if (n === 1) return lastDays >= 90 ? 'one_and_done' : 'other';
  if (lastDays >= 180) return 'hibernating';
  if (n >= 3 && medianGap != null && lastDays >= 2 * medianGap) return 'at_risk';
  if (n >= 5 && lastDays < 30 && aovPaise >= CHAMPION_AOV_PAISE) return 'champions';
  if (n >= 3 && lastDays < 90) return 'loyal';
  if (n === 2 && lastDays < 90) return 'promising';
  return 'other';
}

function classifyInMemory(customers, orders) {
  const byCustomer = new Map();
  for (const o of orders) {
    if (!byCustomer.has(o.customerId)) byCustomer.set(o.customerId, []);
    byCustomer.get(o.customerId).push(o);
  }
  const result = new Map();
  for (const c of customers) {
    const os = byCustomer.get(c.id).sort((a, b) => a.processedAt - b.processedAt);
    const times = os.map((o) => o.processedAt.getTime());
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / DAY);
    const lastDays = (ANCHOR_MS - times[times.length - 1]) / DAY;
    const totalPaise = os.reduce((s, o) => s + o._totalPaise, 0);
    result.set(c.id, classify({
      n: os.length,
      lastDays,
      medianGap: gaps.length ? median(gaps) : null,
      aovPaise: totalPaise / os.length,
    }));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------
function table(headers, rows) {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r) => '  ' + r.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
  const out = [line(headers), '  ' + widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r.map(String)));
  return out.join('\n');
}

function cohortTable(counts, total) {
  const rows = COHORTS.map((c, i) => {
    const target = COHORT_COUNTS[i];
    const actual = counts.get(c.key) ?? 0;
    return [
      c.label,
      `${(c.share * 100).toFixed(0)}%`,
      target,
      actual,
      `${((actual / total) * 100).toFixed(1)}%`,
      actual === target ? 'ok' : `OFF BY ${actual - target}`,
    ];
  });
  const other = counts.get('other') ?? 0;
  rows.push(['(unclassified)', '0%', 0, other, `${((other / total) * 100).toFixed(1)}%`, other === 0 ? 'ok' : 'FAIL']);
  return table(['Cohort', 'Target', 'Target n', 'Actual n', 'Actual %', 'Status'], rows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const t0 = Date.now();
console.log(`Cadence bulk seed — seed=${SEED}, customers=${CUSTOMER_COUNT}, anchor=${ANCHOR.toISOString()}`);
console.log(`  window: ${new Date(ANCHOR_MS - WINDOW_DAYS * DAY).toISOString().slice(0, 10)} → ${ANCHOR.toISOString().slice(0, 10)} (${WINDOW_DAYS} days)`);
if (DRY_RUN) console.log('  MODE: --dry-run (nothing will be written)');

const data = generate();
console.log(
  `\nGenerated: ${data.customers.length} customers · ${data.orders.length} orders · ` +
  `${data.orderItems.length} order items · ${data.consents.length} consents · ${data.events.length} events`,
);
console.log(`  ${data.redraws} customers (${((data.redraws / data.customers.length) * 100).toFixed(1)}%) needed a redraw to land in their cohort`);

// Assert the cohort split in memory before touching the database — a
// generator that misses its targets is a bug to fix, not a rounding note.
const inMemory = classifyInMemory(data.customers, data.orders);
const memCounts = new Map();
for (const v of inMemory.values()) memCounts.set(v, (memCounts.get(v) ?? 0) + 1);
console.log('\nCohort distribution (in-memory, pre-write):');
console.log(cohortTable(memCounts, data.customers.length));

let failures = 0;
COHORTS.forEach((c, i) => {
  if ((memCounts.get(c.key) ?? 0) !== COHORT_COUNTS[i]) failures++;
});
if ((memCounts.get('other') ?? 0) !== 0) failures++;
if (failures) {
  console.error(`\n✗ generator produced ${failures} cohort mismatch(es) — aborting before write.`);
  process.exit(1);
}

if (DRY_RUN) {
  // Shape only: the numbers a reviewer needs to sanity-check the plan.
  const perCustomer = new Map();
  for (const c of data.customers) perCustomer.set(c._orders, (perCustomer.get(c._orders) ?? 0) + 1);
  console.log('\nOrders per customer:');
  console.log(table(['Orders', 'Customers'], [...perCustomer.keys()].sort((a, b) => a - b).map((k) => [k, perCustomer.get(k)])));

  const byMonth = new Map();
  for (const o of data.orders) {
    const k = o.processedAt.toISOString().slice(0, 7);
    byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
  }
  console.log('\nOrders per month:');
  console.log(table(['Month', 'Orders'], [...byMonth.keys()].sort().map((k) => [k, byMonth.get(k)])));

  const medians = [];
  const byCust = new Map();
  for (const o of data.orders) {
    if (!byCust.has(o.customerId)) byCust.set(o.customerId, []);
    byCust.get(o.customerId).push(o.processedAt.getTime());
  }
  for (const ts of byCust.values()) {
    if (ts.length < 2) continue;
    ts.sort((a, b) => a - b);
    medians.push(median(ts.slice(1).map((t, i) => (t - ts[i]) / DAY)));
  }
  medians.sort((a, b) => a - b);
  const pct = (p) => medians[Math.min(medians.length - 1, Math.floor(p * medians.length))];
  console.log(`\nPer-customer median gap (days): min ${Math.round(medians[0])}  p10 ${Math.round(pct(0.1))}  ` +
    `p25 ${Math.round(pct(0.25))}  p50 ${Math.round(pct(0.5))}  p75 ${Math.round(pct(0.75))}  ` +
    `p90 ${Math.round(pct(0.9))}  max ${Math.round(medians[medians.length - 1])}   ` +
    `spread p90/p10 = ${(pct(0.9) / pct(0.1)).toFixed(1)}×`);

  const noPhone = data.customers.filter((c) => c.phoneE164 === null).length;
  console.log(`\nCustomers with no phone: ${noPhone} (${((noPhone / data.customers.length) * 100).toFixed(1)}%)`);
  const abandoned = data.events.filter((e) => e.type === 'checkout_abandoned').length;
  console.log(`Abandoned checkouts: ${abandoned} (${(abandoned / data.orders.length).toFixed(2)}× completed orders)`);
  console.log(`\nDry run complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — nothing written.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
const { db, schema } = await import('../db/index.js');
const { customers, products, orders, orderItems, events, consents } = schema;

/** Build an ON CONFLICT DO UPDATE set clause referencing the excluded row. */
const excluded = (t, keys) =>
  Object.fromEntries(keys.map((k) => [k, sql.raw(`excluded.${t[k].name}`)]));

async function batched(label, table_, rows, keys, chunkSize) {
  if (!rows.length) return;
  process.stdout.write(`  ${label}: `);
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await db.insert(table_).values(chunk).onConflictDoUpdate({
      target: table_.id,
      set: excluded(table_, keys),
    });
    process.stdout.write('.');
  }
  console.log(` ${rows.length}`);
}

// The live schema puts BEFORE UPDATE triggers on customers/orders/products
// that stamp updated_at = now(). They are correct for the application and must
// stay — but they fire on this script's ON CONFLICT DO UPDATE path, so a
// re-run would silently rewrite updated_at on every row and the dataset would
// NOT be reproducible: the same seed would yield different bytes. They are
// switched off for the duration of the write and restored in a finally, so a
// crash mid-seed cannot leave the database with its triggers disabled.
const UPDATED_AT_TRIGGERS = [
  ['customers', 'customers_set_updated_at'],
  ['orders', 'orders_set_updated_at'],
  ['products', 'products_set_updated_at'],
];
async function setUpdatedAtTriggers(enabled) {
  for (const [t, trg] of UPDATED_AT_TRIGGERS) {
    await db.execute(sql.raw(`alter table ${t} ${enabled ? 'enable' : 'disable'} trigger ${trg}`));
  }
}

if (TRUNCATE) {
  console.log('\n--truncate: clearing seeded tables (CASCADE)…');
  await db.execute(
    sql`truncate table order_items, orders, events, consents, customer_scores, customers, products cascade`,
  );
}

console.log('\nWriting…');
await setUpdatedAtTriggers(false);
try {

// products first — order_items reference them, and the CRM-side products table
// is a mirror of the store keyed on the real shopify_product_id (unique in the
// live schema; `handle` is not). Keying on it means a later webhook sync of
// products/update lands on the same row instead of creating a duplicate.
await batched(
  'products     ',
  products,
  PRODUCTS.map((p) => ({
    id: p.id,
    shopifyProductId: p.shopifyProductId,
    title: p.title,
    handle: p.handle,
    collection: p.collection,
    tags: p.tags,
    // Carried across from the catalogue: the Task 4 scoring job reads this to
    // predict next-order dates (PRD-02 §F3.4).
    replenishmentDays: p.replenishmentDays,
    price: toDecimal(p.pricePaise),
    status: 'active',
    // Explicit, not now(): every timestamp this script writes has to be
    // reproducible, products included. The catalogue predates the order window.
    createdAt: CATALOGUE_EPOCH,
    updatedAt: CATALOGUE_EPOCH,
  })),
  ['shopifyProductId', 'title', 'handle', 'collection', 'tags', 'replenishmentDays', 'price', 'status', 'createdAt', 'updatedAt'],
  12,
);

await batched(
  'customers    ',
  customers,
  data.customers.map(({ _cohort, _orders, _lifetimePaise, ...row }) => row),
  ['shopifyCustomerId', 'email', 'phoneE164', 'firstName', 'lastName', 'city', 'state', 'country', 'acceptsMarketing', 'createdAt', 'updatedAt'],
  400,
);

await batched(
  'orders       ',
  orders,
  data.orders.map(({ _totalPaise, _lines, ...row }) => row),
  ['shopifyOrderId', 'orderNumber', 'customerId', 'total', 'subtotal', 'discountTotal', 'discountCodes', 'currency', 'financialStatus', 'processedAt', 'createdAt', 'updatedAt'],
  400,
);

await batched(
  'order_items  ',
  orderItems,
  data.orderItems,
  ['orderId', 'productId', 'variantId', 'title', 'qty', 'price'],
  800,
);

await batched(
  'consents     ',
  consents,
  data.consents,
  ['customerId', 'channel', 'status', 'source', 'updatedAt'],
  800,
);

await batched(
  'events       ',
  events,
  data.events,
  ['customerId', 'sessionId', 'type', 'payload', 'occurredAt'],
  1000,
);

} finally {
  await setUpdatedAtTriggers(true);
}

// ---------------------------------------------------------------------------
// Verification — everything below reads the database back. Nothing here is
// derived from the in-memory generator.
// ---------------------------------------------------------------------------
const anchorLit = sql`${ANCHOR.toISOString()}::timestamptz`;
const rows = async (q) => (await db.execute(q)).rows;

console.log('\n' + '═'.repeat(72));
console.log('VERIFICATION (read back from Postgres)');
console.log('═'.repeat(72));

const counts = await rows(sql`
  select 'customers' as t, count(*)::int as n from customers
  union all select 'products', count(*)::int from products
  union all select 'orders', count(*)::int from orders
  union all select 'order_items', count(*)::int from order_items
  union all select 'consents', count(*)::int from consents
  union all select 'events', count(*)::int from events
  order by 1
`);
const expectedCounts = {
  customers: data.customers.length,
  products: PRODUCTS.length,
  orders: data.orders.length,
  order_items: data.orderItems.length,
  consents: data.consents.length,
  events: data.events.length,
};
console.log('\nRow counts:');
console.log(table(
  ['Table', 'Rows', 'Expected'],
  counts.map((r) => [r.t, r.n, expectedCounts[r.t]]),
));

// The SQL cohort classifier — a literal translation of classify() above.
const cohortRows = await rows(sql`
  with gaps as (
    select customer_id, processed_at, total,
           extract(epoch from (processed_at - lag(processed_at)
             over (partition by customer_id order by processed_at))) / 86400 as gap_days
    from orders
    where customer_id is not null
  ),
  per_customer as (
    select customer_id,
           count(*)::int as n,
           max(processed_at) as last_at,
           sum(total) / count(*) as aov,
           percentile_cont(0.5) within group (order by gap_days)
             filter (where gap_days is not null) as median_gap
    from gaps group by customer_id
  ),
  scored as (
    select *, extract(epoch from (${anchorLit} - last_at)) / 86400 as last_days
    from per_customer
  )
  select case
    when n = 1 then case when last_days >= 90 then 'one_and_done' else 'other' end
    when last_days >= 180 then 'hibernating'
    when n >= 3 and median_gap is not null and last_days >= 2 * median_gap then 'at_risk'
    when n >= 5 and last_days < 30 and aov >= ${CHAMPION_AOV_PAISE / 100} then 'champions'
    when n >= 3 and last_days < 90 then 'loyal'
    when n = 2 and last_days < 90 then 'promising'
    else 'other' end as cohort,
    count(*)::int as n
  from scored group by 1
`);
const dbCounts = new Map(cohortRows.map((r) => [r.cohort, r.n]));
const totalCustomers = counts.find((r) => r.t === 'customers').n;
console.log('\nCohort distribution (target vs actual):');
console.log(cohortTable(dbCounts, totalCustomers));

const perOrders = await rows(sql`
  select n, count(*)::int as customers from (
    select customer_id, count(*)::int as n from orders where customer_id is not null group by 1
  ) x group by 1 order by 1
`);
console.log('\nOrders per customer:');
console.log(table(['Orders', 'Customers'], perOrders.map((r) => [r.n, r.customers])));

const span = (await rows(sql`
  select min(processed_at) as min_at, max(processed_at) as max_at,
         count(*)::int as n,
         count(*) filter (where processed_at is null)::int as undated
  from orders
`))[0];
console.log('\nprocessed_at range:');
console.log(`  min      ${new Date(span.min_at).toISOString()}`);
console.log(`  max      ${new Date(span.max_at).toISOString()}`);
console.log(`  span     ${Math.round((new Date(span.max_at) - new Date(span.min_at)) / DAY)} days over ${span.n} orders`);
console.log(`  undated  ${span.undated}`);

const monthly = await rows(sql`
  select to_char(date_trunc('month', processed_at), 'YYYY-MM') as month, count(*)::int as n
  from orders group by 1 order by 1
`);
const maxMonth = Math.max(...monthly.map((m) => m.n));
console.log('\nOrders per month (festive uplift should show in 2025-10/11):');
console.log(table(['Month', 'Orders', ''], monthly.map((m) => [m.month, m.n, '█'.repeat(Math.round((m.n / maxMonth) * 34))])));

const phone = (await rows(sql`
  select count(*)::int as total,
         count(*) filter (where phone_e164 is null)::int as no_phone,
         count(*) filter (where email is null)::int as no_email,
         count(phone_e164)::int as with_phone,
         count(distinct phone_e164)::int as distinct_phones,
         count(*) filter (where phone_e164 is not null and phone_e164 !~ ${PHONE_PATTERN})::int as malformed
  from customers
`))[0];
console.log(`\nCustomers with no phone: ${phone.no_phone} / ${phone.total} (${((phone.no_phone / phone.total) * 100).toFixed(1)}%)  |  no email: ${phone.no_email}`);
console.log(`Phone format (${PHONE_PATTERN}): ${phone.with_phone - phone.malformed}/${phone.with_phone} valid, ${phone.distinct_phones} distinct, ${phone.malformed} malformed`);

const consentSpread = await rows(sql`
  select channel::text as channel, status::text as status, count(*)::int as n
  from consents group by 1, 2 order by 1, 2
`);
console.log('\nConsent spread (channel × status):');
console.log(table(['Channel', 'Status', 'Rows'], consentSpread.map((r) => [r.channel, r.status, r.n])));
const consentSources = await rows(sql`
  select channel::text as channel, count(distinct source)::int as sources,
         count(*) filter (where source is null)::int as null_source,
         count(*) filter (where updated_at is null)::int as null_ts
  from consents group by 1 order by 1
`);
console.log(table(['Channel', 'Distinct sources', 'NULL source', 'NULL timestamp'], consentSources.map((r) => [r.channel, r.sources, r.null_source, r.null_ts])));

const eventSpread = await rows(sql`
  select type, count(*)::int as n, min(occurred_at) as first_at, max(occurred_at) as last_at
  from events group by 1 order by 2 desc
`);
console.log('\nEvents by type:');
console.log(table(
  ['Type', 'Rows', 'First', 'Last'],
  eventSpread.map((r) => [r.type, r.n, new Date(r.first_at).toISOString().slice(0, 10), new Date(r.last_at).toISOString().slice(0, 10)]),
));
const abandoned = eventSpread.find((r) => r.type === 'checkout_abandoned')?.n ?? 0;
console.log(`  abandoned checkouts / completed orders = ${(abandoned / span.n).toFixed(2)}× (target ≈ 3×)`);

const cadence = (await rows(sql`
  with gaps as (
    select customer_id,
           extract(epoch from (processed_at - lag(processed_at)
             over (partition by customer_id order by processed_at))) / 86400 as gap_days
    from orders where customer_id is not null
  ),
  med as (
    select customer_id, percentile_cont(0.5) within group (order by gap_days) as m
    from gaps where gap_days is not null group by 1
  )
  select count(*)::int as customers,
         round(min(m))::int as min_gap,
         round(percentile_cont(0.10) within group (order by m))::int as p10,
         round(percentile_cont(0.25) within group (order by m))::int as p25,
         round(percentile_cont(0.5) within group (order by m))::int as p50,
         round(percentile_cont(0.75) within group (order by m))::int as p75,
         round(percentile_cont(0.90) within group (order by m))::int as p90,
         round(max(m))::int as max_gap,
         count(distinct round(m))::int as distinct_medians
  from med
`))[0];
console.log('\nPer-customer median inter-purchase gap (days) — the spread churn detection needs:');
console.log(table(
  ['Customers', 'min', 'p10', 'p25', 'p50', 'p75', 'p90', 'max', 'distinct values'],
  [[cadence.customers, cadence.min_gap, cadence.p10, cadence.p25, cadence.p50, cadence.p75, cadence.p90, cadence.max_gap, cadence.distinct_medians]],
));
console.log(`  spread p90/p10 = ${(cadence.p90 / cadence.p10).toFixed(1)}×  (a rules engine can only beat per-customer cadence when this is near 1×)`);

// Does the spread actually come from the catalogue, or from the random draw?
// Each customer's cadence is built from the replenishment cycle of the variant
// they habitually buy, so their realized gaps should track the replenishment
// days of what is actually in their orders. products.replenishment_days is
// product-level (30–60); the seed keys off the variant value (30–75), so this
// correlation is attenuated and still worth reporting honestly.
const replenLink = await rows(sql`
  with med as (
    select customer_id, percentile_cont(0.5) within group (order by gap) as m from (
      select customer_id,
             extract(epoch from (processed_at - lag(processed_at)
               over (partition by customer_id order by processed_at))) / 86400 as gap
      from orders where customer_id is not null
    ) g where gap is not null group by 1
  ),
  basket as (
    select o.customer_id,
           percentile_cont(0.5) within group (order by p.replenishment_days) as replen
    from orders o
      join order_items oi on oi.order_id = o.id
      join products p on p.id = oi.product_id
    where o.customer_id is not null
    group by 1
  )
  select b.replen::int as replen_days, count(*)::int as customers,
         round(percentile_cont(0.5) within group (order by m))::int as median_gap,
         round(min(m))::int as gap_lo, round(max(m))::int as gap_hi
  from med join basket b using (customer_id)
  group by 1 order by 1
`);
const replenCorr = (await rows(sql`
  with med as (
    select customer_id, percentile_cont(0.5) within group (order by gap) as m from (
      select customer_id,
             extract(epoch from (processed_at - lag(processed_at)
               over (partition by customer_id order by processed_at))) / 86400 as gap
      from orders where customer_id is not null
    ) g where gap is not null group by 1
  ),
  basket as (
    select o.customer_id,
           percentile_cont(0.5) within group (order by p.replenishment_days) as replen
    from orders o join order_items oi on oi.order_id = o.id join products p on p.id = oi.product_id
    where o.customer_id is not null group by 1
  )
  select round(corr(b.replen, m.m)::numeric, 3) as r, count(*)::int as n
  from med m join basket b using (customer_id)
`))[0];
console.log('\nCadence vs what they buy (median product replenishment_days in their orders):');
console.log(table(
  ['Median replen (d)', 'Customers', 'Median gap (d)', 'gap min', 'gap max'],
  replenLink.map((r) => [r.replen_days, r.customers, r.median_gap, r.gap_lo, r.gap_hi]),
));
console.log(`  corr(basket replenishment_days, own median gap) = ${replenCorr.r} over ${replenCorr.n} customers`);

// The product-level number above understates the link, and it is worth being
// precise about why rather than quoting the flattering figure alone. The seed
// builds a cadence from the VARIANT's cycle times the units bought per order —
// a 200ml hair oil is 75 days where the product row says 45, and two bottles
// is twice that. order_items carries variant_id and qty, so the effective
// consumption window is recoverable from the database; only the variant→cycle
// lookup lives in the catalogue rather than in a table.
const variantReplenValues = PRODUCTS
  .flatMap((p) => p.variants.map((v) => `(${v.shopifyVariantId}::bigint, ${v.replenishmentDays}::int)`))
  .join(', ');
const effective = (await rows(sql`
  with vr(variant_id, replen) as (values ${sql.raw(variantReplenValues)}),
  med as (
    select customer_id, percentile_cont(0.5) within group (order by gap) as m from (
      select customer_id,
             extract(epoch from (processed_at - lag(processed_at)
               over (partition by customer_id order by processed_at))) / 86400 as gap
      from orders where customer_id is not null
    ) g where gap is not null group by 1
  ),
  consumption as (
    select o.customer_id,
           percentile_cont(0.5) within group (order by vr.replen * oi.qty) as days_of_supply
    from orders o
      join order_items oi on oi.order_id = o.id
      join vr on vr.variant_id = oi.variant_id
    where o.customer_id is not null
    group by 1
  )
  select round(corr(c.days_of_supply, m.m)::numeric, 3) as r, count(*)::int as n,
         round(percentile_cont(0.10) within group (order by c.days_of_supply)::numeric)::int as p10,
         round(percentile_cont(0.50) within group (order by c.days_of_supply)::numeric)::int as p50,
         round(percentile_cont(0.90) within group (order by c.days_of_supply)::numeric)::int as p90
  from med m join consumption c using (customer_id)
`))[0];
console.log(`  corr(variant cycle × units bought, own median gap) = ${effective.r} over ${effective.n} customers`);
console.log(`  their median days-of-supply per line: p10 ${effective.p10}  p50 ${effective.p50}  p90 ${effective.p90}`);

const productLink = (await rows(sql`
  select count(*)::int as items,
         count(*) filter (where product_id is null)::int as orphan_items,
         count(distinct product_id)::int as distinct_products,
         count(*) filter (where variant_id is null)::int as null_variants
  from order_items
`))[0];
console.log(`\norder_items → products: ${productLink.items} items, ${productLink.distinct_products} distinct products, ${productLink.orphan_items} unlinked, ${productLink.null_variants} without a variant id`);
const replen = (await rows(sql`
  select count(*)::int as n, count(replenishment_days)::int as with_replen,
         min(replenishment_days)::int as lo, max(replenishment_days)::int as hi
  from products
`))[0];
console.log(`products: ${replen.n} rows, ${replen.with_replen} carry replenishment_days (${replen.lo}–${replen.hi} days)`);

// ---- determinism: updated_at, triggers, and a content fingerprint ---------
// updated_at is the column most likely to quietly break reproducibility,
// because the schema's BEFORE UPDATE triggers own it and the upsert path is an
// UPDATE. Assert the database holds the timestamps this run generated, not the
// wall clock, and fold updated_at into the fingerprint so the idempotency
// evidence actually covers it.
const maxOf = (xs, f) => Math.max(...xs.map((x) => f(x).getTime()));
const expectedUpdatedAt = {
  customers: maxOf(data.customers, (c) => c.updatedAt),
  orders: maxOf(data.orders, (o) => o.updatedAt),
  products: CATALOGUE_EPOCH.getTime(),
};
const actualUpdatedAt = (await rows(sql`
  select 'customers' as t, max(updated_at) as max_at from customers
  union all select 'orders', max(updated_at) from orders
  union all select 'products', max(updated_at) from products
`)).reduce((acc, r) => ({ ...acc, [r.t]: new Date(r.max_at).getTime() }), {});
console.log('\nmax(updated_at) — generated vs stored (the trigger-contamination check):');
console.log(table(
  ['Table', 'Generated', 'Stored', 'Match'],
  Object.keys(expectedUpdatedAt).map((t) => [
    t,
    new Date(expectedUpdatedAt[t]).toISOString(),
    new Date(actualUpdatedAt[t]).toISOString(),
    expectedUpdatedAt[t] === actualUpdatedAt[t] ? 'ok' : 'DRIFTED',
  ]),
));

const triggerState = await rows(sql`
  select c.relname as tbl, t.tgname, t.tgenabled::text as enabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where t.tgname in ('customers_set_updated_at', 'orders_set_updated_at', 'products_set_updated_at')
  order by 1
`);
console.log(`set_updated_at triggers restored: ${triggerState.map((r) => `${r.tbl}=${r.enabled === 'O' ? 'enabled' : r.enabled}`).join(', ')}`);

const fingerprint = (await rows(sql`
  select
    (select md5(string_agg(id::text || coalesce(email,'') || coalesce(phone_e164,'') || created_at::text || updated_at::text, ',' order by shopify_customer_id)) from customers) as customers,
    (select md5(string_agg(id::text || total || subtotal || processed_at::text || created_at::text || updated_at::text, ',' order by shopify_order_id)) from orders) as orders,
    (select md5(string_agg(id::text || qty || price, ',' order by id)) from order_items) as order_items,
    (select md5(string_agg(id::text || status::text || coalesce(source,'') || updated_at::text, ',' order by id)) from consents) as consents,
    (select md5(string_agg(id::text || type || occurred_at::text, ',' order by id)) from events) as events,
    (select md5(string_agg(id::text || handle || price || created_at::text || updated_at::text, ',' order by shopify_product_id)) from products) as products
`))[0];
console.log('\nContent fingerprints (md5, updated_at included — identical across re-runs):');
console.log(table(['Table', 'Fingerprint'], Object.entries(fingerprint).map(([k, v]) => [k, v])));

// ---- assertions -----------------------------------------------------------
const problems = [];
if (phone.malformed) problems.push(`${phone.malformed} of ${phone.with_phone} phone numbers do not match ${PHONE_PATTERN} — unusable as the WhatsApp join key (PRD-01 §4.1)`);
if (phone.distinct_phones !== phone.with_phone) problems.push(`phone numbers are not unique: ${phone.distinct_phones} distinct across ${phone.with_phone} rows`);
for (const [t, want] of Object.entries(expectedUpdatedAt)) {
  if (actualUpdatedAt[t] !== want) {
    problems.push(`${t}.updated_at drifted from the generated value (stored ${new Date(actualUpdatedAt[t]).toISOString()}, generated ${new Date(want).toISOString()}) — the set_updated_at trigger fired during the upsert`);
  }
}
for (const r of triggerState) {
  if (r.enabled !== 'O') problems.push(`trigger ${r.tgname} was left ${r.enabled} instead of enabled`);
}
// Upsert-by-primary-key is exact only for the generator that produced those
// keys. If the generation logic changed (different basket sizes, different
// event mix), the previous run's surplus rows are still sitting there — the
// counts are the tell, and --truncate is the fix.
for (const r of counts) {
  if (r.n !== expectedCounts[r.t]) {
    problems.push(
      `${r.t}: ${r.n} rows in the database but ${expectedCounts[r.t]} generated` +
      (r.n > expectedCounts[r.t] ? ' — stale rows from an earlier generator version; re-run with --truncate' : ''),
    );
  }
}
COHORTS.forEach((c, i) => {
  const actual = dbCounts.get(c.key) ?? 0;
  if (actual !== COHORT_COUNTS[i]) problems.push(`${c.label}: target ${COHORT_COUNTS[i]}, actual ${actual}`);
});
if ((dbCounts.get('other') ?? 0) !== 0) problems.push(`${dbCounts.get('other')} customers fall outside every cohort`);
if (span.undated) problems.push(`${span.undated} orders have no processed_at`);
if (productLink.orphan_items) problems.push(`${productLink.orphan_items} order_items are not linked to a product`);
if (replen.with_replen !== 12) problems.push(`only ${replen.with_replen}/12 products carry replenishment_days`);
if (abandoned / span.n < 2.5 || abandoned / span.n > 3.6) problems.push(`abandoned/order ratio ${(abandoned / span.n).toFixed(2)} is outside 2.5–3.6×`);

console.log('\n' + '═'.repeat(72));
if (problems.length) {
  console.error('✗ SEED VERIFICATION FAILED');
  for (const p of problems) console.error(`  · ${p}`);
  process.exitCode = 1;
} else {
  console.log(`✓ seed verified — cohorts match targets exactly, ${span.n} dated orders across ${Math.round((new Date(span.max_at) - new Date(span.min_at)) / DAY)} days`);
}
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(process.exitCode ?? 0);
