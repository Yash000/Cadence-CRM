// Seeds rasaya-dev with the integration-proof half of the data strategy
// (task-2-brief.md; supersedes PRD-01 §5.2's 40/80 split — see brief).
//
//   node scripts/seed-shopify.mjs [--dry-run] [--resume]
//
// Two-phase execution (mandatory per brief):
//   1. Generate the full dataset deterministically, write data/shopify-seed.json,
//      verify its shape locally against the brief's requirements.
//   2. Push to Shopify — customers first, then orders (rate-limited ~4.8/min,
//      so ~120 orders takes ~25 minutes). --dry-run stops after step 1.
//
// Re-runnable (PRD-01 §10): the dataset is generated from a fixed RNG seed, so
// every run produces the identical customer/order plan. Each order carries a
// unique `seed:<key>` tag; --resume queries the store for tags already present
// and skips those, so a killed run can be restarted without duplicating orders.
// Each customer is looked up by email before creation for the same reason.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gql, gqlWithBackoff } from './lib/shopify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(HERE, '..', 'data', 'shopify-seed.json');
const CATALOGUE_FILE = join(HERE, '..', 'data', 'catalogue.json');
const LOG_FILE = join(HERE, '..', 'data', 'seed-shopify.log');

// Log to both console and a file, flushed synchronously per line, so a killed
// process leaves a recoverable trail of exactly how far it got (coordinator
// feedback after the first run died silently mid-log-pipe).
function log(msg) {
  console.log(msg);
  try { appendFileSync(LOG_FILE, msg + '\n'); } catch { /* best-effort */ }
}
appendFileSync(LOG_FILE, `\n\n=== run started ${new Date().toISOString()} args=${process.argv.slice(2).join(' ')} ===\n`);

// Belt-and-braces: make sure nothing dies silently off the event loop without
// a line in the log (coordinator feedback: the first run's process exit had
// no diagnostic trail).
process.on('unhandledRejection', (reason) => {
  log(`\nFATAL (unhandledRejection): ${reason?.stack || reason}`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log(`\nFATAL (uncaughtException): ${err?.stack || err}`);
  process.exit(1);
});

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');
const RESUME = ARGS.has('--resume');

const NOW = new Date('2026-08-24T09:00:00Z'); // deterministic anchor — currentDate
const WINDOW_DAYS = 18 * 30; // ~18 months

// ── deterministic RNG (mulberry32) — fixed seed so every run is identical ───
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260824);
const rand = () => rng();
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
function pickWeighted(items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const it of items) { r -= it.weight; if (r <= 0) return it.value; }
  return items[items.length - 1].value;
}

// ── reference data ───────────────────────────────────────────────────────────
const FIRST_NAMES_M = ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna', 'Ishaan', 'Rohan', 'Kabir', 'Aryan', 'Dev', 'Karan', 'Nikhil', 'Rahul'];
const FIRST_NAMES_F = ['Ananya', 'Diya', 'Saanvi', 'Aadhya', 'Kiara', 'Myra', 'Pari', 'Anika', 'Riya', 'Isha', 'Neha', 'Priya', 'Sneha', 'Kavya', 'Meera', 'Shreya'];
const LAST_NAMES = ['Sharma', 'Verma', 'Gupta', 'Iyer', 'Nair', 'Menon', 'Reddy', 'Rao', 'Patel', 'Shah', 'Desai', 'Mehta', 'Joshi', 'Kapoor', 'Malhotra', 'Chatterjee', 'Banerjee', 'Pillai', 'Krishnan', 'Agarwal', 'Bansal', 'Bhat', 'Kulkarni'];

const CITIES = [
  { name: 'Mumbai', weight: 14 }, { name: 'Delhi', weight: 14 }, { name: 'Bengaluru', weight: 13 },
  { name: 'Hyderabad', weight: 10 }, { name: 'Chennai', weight: 10 }, { name: 'Pune', weight: 9 },
  { name: 'Kolkata', weight: 8 }, { name: 'Ahmedabad', weight: 6 },
  { name: 'Jaipur', weight: 4 }, { name: 'Lucknow', weight: 3 }, { name: 'Indore', weight: 3 },
  { name: 'Coimbatore', weight: 2 }, { name: 'Nagpur', weight: 2 }, { name: 'Bhopal', weight: 2 } ,
];

const cat = JSON.parse(readFileSync(CATALOGUE_FILE, 'utf8'));
const ALL_VARIANTS = cat.products.flatMap((p) =>
  p.variants.map((v) => ({ sku: v.sku, price: v.price, title: `${p.title} — ${v.title}`, productType: p.product_type }))
);
const SERUM_VARIANTS = ALL_VARIANTS.filter((v) => v.productType === 'Serum' || v.productType === 'Scalp Serum');

// ── segment plan — PRD-01 §5.3 definitions, volumes per task-2-brief.md ─────
// Each entry: how many customers, how many orders each gets, and the cadence/
// recency rule that makes them qualify for that named segment.
const SEGMENT_PLAN = [
  { key: 'champions', label: 'Champions', tag: 'segment-champions', customers: 4, orderCounts: [6, 7, 6, 8], lastOrderDaysAgo: () => randInt(3, 25), cadenceMean: () => randInt(25, 35) },
  { key: 'loyal', label: 'Loyal', tag: 'segment-loyal', customers: 8, orderCounts: [5, 5, 4, 5, 4, 4, 5, 4], lastOrderDaysAgo: () => randInt(15, 55), cadenceMean: () => randInt(35, 50) },
  { key: 'promising', label: 'Promising', tag: 'segment-promising', customers: 4, orderCounts: [2, 2, 2, 2], lastOrderDaysAgo: () => randInt(5, 25), cadenceMean: () => randInt(20, 35) },
  { key: 'at_risk', label: 'At Risk', tag: 'segment-at-risk', customers: 8, orderCounts: [3, 5, 4, 5, 4, 4, 5, 4], lastOrderDaysAgo: (i) => (i === 0 ? 140 : randInt(90, 150)), cadenceMean: () => randInt(35, 50) },
  { key: 'hibernating', label: 'Hibernating', tag: 'segment-hibernating', customers: 4, orderCounts: [2, 3, 2, 3], lastOrderDaysAgo: () => randInt(190, 460), cadenceMean: () => randInt(40, 70) },
  { key: 'one_and_done', label: 'One-and-done', tag: 'segment-one-and-done', customers: 2, orderCounts: [1, 1], lastOrderDaysAgo: () => randInt(95, 520), cadenceMean: () => 0 },
];

const TOTAL_CUSTOMERS = SEGMENT_PLAN.reduce((s, g) => s + g.customers, 0);
const NO_PHONE_COUNT = 4; // §F1.5 identity-resolution edge case

// ── build customers ──────────────────────────────────────────────────────────
const usedNames = new Set();
function uniqueName(idx) {
  let first, last, key;
  do {
    const isMale = rand() < 0.5;
    first = pick(isMale ? FIRST_NAMES_M : FIRST_NAMES_F);
    last = pick(LAST_NAMES);
    key = `${first}-${last}`;
  } while (usedNames.has(key));
  usedNames.add(key);
  return { first, last };
}

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 86400000);
}

function buildOrdersForCustomer(seg, orderCount, segIndex) {
  const cadenceMean = seg.cadenceMean();
  const lastDaysAgo = seg.lastOrderDaysAgo(segIndex);
  // Walk backward from the last order, jittering each gap around cadenceMean
  // so cadence is drawn from a distribution, never a fixed interval.
  const offsetsFromNow = [lastDaysAgo];
  for (let i = 1; i < orderCount; i++) {
    const jitter = 0.55 + rand() * 0.9; // 0.55x – 1.45x of the personal mean
    const gap = Math.max(12, Math.round(cadenceMean * jitter));
    offsetsFromNow.push(offsetsFromNow[offsetsFromNow.length - 1] + gap);
  }
  // Clamp inside the 18-month window; compress proportionally if we overflow.
  const maxOffset = Math.max(...offsetsFromNow);
  if (maxOffset > WINDOW_DAYS - 5) {
    const scale = (WINDOW_DAYS - 5) / maxOffset;
    for (let i = 0; i < offsetsFromNow.length; i++) offsetsFromNow[i] = Math.round(offsetsFromNow[i] * scale);
  }
  offsetsFromNow.reverse(); // oldest first (daysAgo descending as time moves forward)
  const gaps = offsetsFromNow.slice(1).map((v, i) => offsetsFromNow[i] - v); // positive day counts between orders
  const medianGap = gaps.length
    ? [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)]
    : null;
  return { offsetsFromNow, medianGap };
}

function pickLineItems(rngBiasSerum) {
  const n = randInt(1, 3);
  const items = [];
  for (let i = 0; i < n; i++) {
    const v = rngBiasSerum && i === 0 && rand() < 0.7 ? pick(SERUM_VARIANTS) : pick(ALL_VARIANTS);
    items.push({ sku: v.sku, title: v.title, price: v.price, quantity: randInt(1, 2) });
  }
  return items;
}

const customers = [];
let custSeq = 0;
const noPhoneIdxSet = new Set();
{
  // spread the no-phone customers across segments rather than clustering them
  const spread = [];
  let cursor = 0;
  for (const seg of SEGMENT_PLAN) { spread.push(cursor); cursor += seg.customers; }
  const chosen = [2, 9, 17, 24].filter((i) => i < TOTAL_CUSTOMERS);
  for (const c of chosen) noPhoneIdxSet.add(c);
}

let globalIdx = 0;
for (const seg of SEGMENT_PLAN) {
  for (let i = 0; i < seg.customers; i++, globalIdx++) {
    custSeq++;
    const key = `C${String(custSeq).padStart(2, '0')}`;
    const { first, last } = uniqueName(globalIdx);
    const city = pickWeighted(CITIES.map((c) => ({ value: c.name, weight: c.weight })));
    const hasPhone = !noPhoneIdxSet.has(globalIdx);
    const phone = hasPhone ? `+91${String(7000000000 + globalIdx * 137 + custSeq).slice(0, 10)}` : null;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${custSeq}@cadence-seed.test`;

    const emailConsentStates = ['SUBSCRIBED', 'PENDING', 'UNSUBSCRIBED', null]; // null → default NOT_SUBSCRIBED
    const smsConsentStates = ['SUBSCRIBED', 'PENDING', 'UNSUBSCRIBED', null];
    const emailConsent = emailConsentStates[globalIdx % emailConsentStates.length];
    const smsConsent = hasPhone ? smsConsentStates[(globalIdx + 2) % smsConsentStates.length] : null;

    const { offsetsFromNow, medianGap } = buildOrdersForCustomer(seg, seg.orderCounts[i], i);
    const isProtagonist = seg.key === 'at_risk' && i === 0;

    const orders = offsetsFromNow.map((offset, oi) => {
      const isLast = oi === offsetsFromNow.length - 1;
      const lineItems = pickLineItems(isProtagonist && isLast);
      return {
        seedId: `${key}-O${String(oi + 1).padStart(2, '0')}`,
        processedAt: daysAgo(offset).toISOString(),
        daysAgo: offset,
        lineItems,
      };
    });

    customers.push({
      key,
      firstName: first,
      lastName: last,
      email,
      phone,
      city,
      segment: seg.key,
      segmentLabel: seg.label,
      segmentTag: seg.tag,
      isProtagonist,
      emailConsent,
      smsConsent,
      medianGapDays: medianGap,
      lastOrderDaysAgo: offsetsFromNow[offsetsFromNow.length - 1],
      orders,
    });
  }
}

const dataset = {
  _meta: {
    generatedAt: new Date().toISOString(),
    rngSeed: 20260824,
    anchorNow: NOW.toISOString(),
    windowDays: WINDOW_DAYS,
    totalCustomers: customers.length,
    totalOrders: customers.reduce((s, c) => s + c.orders.length, 0),
  },
  customers,
};

// ── verify shape locally, BEFORE touching the store ─────────────────────────
function verify(ds) {
  const issues = [];
  const cs = ds.customers;
  const totalOrders = cs.reduce((s, c) => s + c.orders.length, 0);
  const avgOrders = totalOrders / cs.length;

  if (cs.length !== 30) issues.push(`expected 30 customers, got ${cs.length}`);
  if (totalOrders < 100 || totalOrders > 140) issues.push(`expected ~120 orders, got ${totalOrders}`);
  if (avgOrders < 3.5 || avgOrders > 4.5) issues.push(`expected ~4 avg orders/customer, got ${avgOrders.toFixed(2)}`);

  const with3plus = cs.filter((c) => c.orders.length >= 3).length;
  if (with3plus < 20) issues.push(`expected >=20 customers with 3+ orders, got ${with3plus}`);

  const noPhone = cs.filter((c) => !c.phone).length;
  if (noPhone < 3 || noPhone > 4) issues.push(`expected 3-4 no-phone customers, got ${noPhone}`);

  const segCounts = {};
  for (const c of cs) segCounts[c.segment] = (segCounts[c.segment] || 0) + 1;
  for (const seg of SEGMENT_PLAN) {
    if ((segCounts[seg.key] || 0) < 2) issues.push(`segment ${seg.key} has <2 customers`);
  }

  const emailStates = new Set(cs.map((c) => c.emailConsent ?? 'NOT_SUBSCRIBED'));
  const smsStates = new Set(cs.filter((c) => c.phone).map((c) => c.smsConsent ?? 'NOT_SUBSCRIBED'));
  if (emailStates.size < 2) issues.push('email consent states are not mixed');
  if (smsStates.size < 2) issues.push('WhatsApp/SMS consent states are not mixed');

  const dates = cs.flatMap((c) => c.orders.map((o) => new Date(o.processedAt).getTime()));
  const spanDays = (Math.max(...dates) - Math.min(...dates)) / 86400000;
  if (spanDays < 400) issues.push(`order date span only ${spanDays.toFixed(0)} days, expected close to 18 months`);

  const protagonists = cs.filter((c) => c.isProtagonist);
  if (protagonists.length !== 1) {
    issues.push(`expected exactly 1 protagonist, got ${protagonists.length}`);
  } else {
    const p = protagonists[0];
    if (p.segment !== 'at_risk') issues.push('protagonist is not At Risk');
    if (!p.phone) issues.push('protagonist has no phone');
    if (p.orders.length < 3) issues.push('protagonist has <3 orders');
    if (Math.abs(p.lastOrderDaysAgo - 140) > 15) issues.push(`protagonist last order ${p.lastOrderDaysAgo}d ago, expected ~140`);
    const lastOrder = p.orders[p.orders.length - 1];
    const buysSerum = lastOrder.lineItems.some((li) => SERUM_VARIANTS.some((v) => v.sku === li.sku));
    if (!buysSerum) issues.push('protagonist last order is not a serum purchase');
  }

  const negMedian = cs.filter((c) => c.medianGapDays != null && c.medianGapDays <= 0);
  if (negMedian.length) issues.push(`${negMedian.length} customers have a non-positive median inter-purchase gap (${negMedian.map((c) => c.key).join(', ')})`);

  // every SKU referenced must be real
  const realSkus = new Set(ALL_VARIANTS.map((v) => v.sku));
  for (const c of cs) for (const o of c.orders) for (const li of o.lineItems) {
    if (!realSkus.has(li.sku)) issues.push(`unknown SKU ${li.sku} on ${o.seedId}`);
  }

  return { ok: issues.length === 0, issues, summary: { totalCustomers: cs.length, totalOrders, avgOrders, with3plus, noPhone, segCounts, spanDays } };
}

function printSummaryTable(ds, v) {
  console.log('\n=== Generated dataset summary ===');
  console.log(`customers: ${v.summary.totalCustomers}   orders: ${v.summary.totalOrders}   avg/customer: ${v.summary.avgOrders.toFixed(2)}`);
  console.log(`customers with 3+ orders: ${v.summary.with3plus}   no-phone: ${v.summary.noPhone}`);
  console.log(`order date span: ${v.summary.spanDays.toFixed(0)} days\n`);
  console.log('segment'.padEnd(16) + 'customers'.padEnd(11) + 'orders'.padEnd(9) + 'avg');
  for (const seg of SEGMENT_PLAN) {
    const segCustomers = ds.customers.filter((c) => c.segment === seg.key);
    const segOrders = segCustomers.reduce((s, c) => s + c.orders.length, 0);
    console.log(
      seg.label.padEnd(16) +
      String(segCustomers.length).padEnd(11) +
      String(segOrders).padEnd(9) +
      (segOrders / segCustomers.length).toFixed(1)
    );
  }
  const protagonist = ds.customers.find((c) => c.isProtagonist);
  console.log(`\nprotagonist: ${protagonist.firstName} ${protagonist.lastName} (${protagonist.key}) — ${protagonist.segmentLabel}, ${protagonist.orders.length} orders, last ${protagonist.lastOrderDaysAgo}d ago, phone=${protagonist.phone}`);
  console.log('');
}

const verification = verify(dataset);
writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2));
console.log(`Wrote ${dataset.customers.length} customers / ${dataset._meta.totalOrders} orders to ${DATA_FILE}`);
printSummaryTable(dataset, verification);

if (!verification.ok) {
  console.error('✗ LOCAL VERIFICATION FAILED:');
  for (const i of verification.issues) console.error(`  - ${i}`);
  process.exit(1);
}
console.log('✓ local verification passed — shape matches task-2-brief.md\n');

if (DRY_RUN) {
  console.log('--dry-run: stopping after JSON generation + verification.');
  process.exit(0);
}

// ── phase 2: push to Shopify ─────────────────────────────────────────────────

function resolveVariantIds() {
  console.log('Resolving variant IDs by SKU…');
  const data = gql(`query { productVariants(first: 50) { edges { node { id sku } } } }`);
  const map = new Map(data.productVariants.edges.map((e) => [e.node.sku, e.node.id]));
  for (const sku of ALL_VARIANTS.map((v) => v.sku)) {
    if (!map.has(sku)) throw new Error(`variant SKU ${sku} not found on store — is the catalogue pushed?`);
  }
  console.log(`  ✓ resolved ${map.size} variants\n`);
  return map;
}

function findCustomerByEmail(email) {
  const data = gql(`query ($q: String!) { customers(first: 1, query: $q) { edges { node { id } } } }`, {
    q: `email:${email}`,
  });
  return data.customers.edges[0]?.node.id ?? null;
}

const CUSTOMER_CREATE = `
mutation ($input: CustomerInput!) {
  customerCreate(input: $input) {
    customer { id }
    userErrors { field message }
  }
}`;

function pushCustomers(ds) {
  log('=== Pushing customers ===');
  for (const c of ds.customers) {
    let id = findCustomerByEmail(c.email);
    if (id) {
      log(`  · ${c.key} ${c.firstName} ${c.lastName} exists`);
      c._shopifyId = id;
      continue;
    }
    const input = {
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      tags: ['cadence-seed', c.segmentTag, `city-${c.city.toLowerCase().replace(/\s+/g, '-')}`],
      note: `Cadence seed — ${c.segmentLabel}${c.isProtagonist ? ' (demo protagonist)' : ''}`,
    };
    if (c.phone) input.phone = c.phone;
    if (c.emailConsent) {
      const optIn = c.emailConsent === 'PENDING' ? 'CONFIRMED_OPT_IN' : 'SINGLE_OPT_IN';
      input.emailMarketingConsent = { marketingState: c.emailConsent, marketingOptInLevel: optIn, consentUpdatedAt: c.orders[0].processedAt };
    }
    if (c.phone && c.smsConsent) {
      const optIn = c.smsConsent === 'PENDING' ? 'CONFIRMED_OPT_IN' : 'SINGLE_OPT_IN';
      input.smsMarketingConsent = { marketingState: c.smsConsent, marketingOptInLevel: optIn, consentUpdatedAt: c.orders[0].processedAt };
    }
    const res = gql(CUSTOMER_CREATE, { input });
    id = res.customerCreate.customer.id;
    c._shopifyId = id;
    log(`  ✓ ${c.key} ${c.firstName} ${c.lastName} created (${c.segmentLabel})`);
  }
  log('');
}

// Always check the store for already-seeded orders before pushing — not just
// on --resume. A killed run leaves partial state on the store regardless of
// whether the *next* invocation happens to pass --resume, and re-creating
// orders that already exist would double-count a customer's order history.
// --resume is kept as an explicit flag for clarity/logging, but the skip-set
// lookup itself is unconditional so a bare re-run is always safe.
function fetchExistingSeedTags() {
  log('Checking store for orders already seeded…');
  const seen = new Set();
  let after = null;
  for (;;) {
    const data = gql(
      `query ($after: String) { orders(first: 100, after: $after, query: "tag:cadence-seed") {
         edges { cursor node { tags } }
         pageInfo { hasNextPage }
       } }`,
      { after }
    );
    for (const edge of data.orders.edges) {
      for (const t of edge.node.tags) if (t.startsWith('seed:')) seen.add(t.slice(5));
      after = edge.cursor;
    }
    if (!data.orders.pageInfo.hasNextPage) break;
  }
  log(`  ${seen.size} orders already on the store, will be skipped\n`);
  return seen;
}

const ORDER_CREATE = readFileSync(join(HERE, 'gql', 'order-create.graphql'), 'utf8');

async function pushOrdersAsync(ds, variantMap, skipSet) {
  const allOrders = ds.customers.flatMap((c) => c.orders.map((o) => ({ customer: c, order: o })));
  log(`=== Pushing orders (${allOrders.length} total, rate-limited ~4.8/min, expect ~${Math.ceil(allOrders.length / 4.8)} min) ===`);
  let done = 0, skipped = 0;
  const t0 = Date.now();
  for (const { customer: c, order: o } of allOrders) {
    if (skipSet && skipSet.has(o.seedId)) {
      skipped++;
      log(`  ⤼ ${o.seedId} already on store, skipping`);
      continue;
    }
    const lineItems = o.lineItems.map((li) => ({
      variantId: variantMap.get(li.sku),
      title: li.title,
      quantity: li.quantity,
      requiresShipping: true,
      priceSet: { shopMoney: { amount: li.price, currencyCode: 'INR' } },
    }));
    const input = {
      currency: 'INR',
      processedAt: o.processedAt,
      financialStatus: 'PAID',
      email: c.email,
      customer: { toAssociate: { id: c._shopifyId } },
      tags: ['cadence-seed', c.segmentTag, `seed:${o.seedId}`],
      note: `Cadence seed order ${o.seedId} for ${c.firstName} ${c.lastName} (${c.segmentLabel})`,
      lineItems,
    };
    if (c.phone) input.phone = c.phone;

    const started = Date.now();
    try {
      await gqlWithBackoff(ORDER_CREATE, { order: input });
    } catch (e) {
      log(`  ✗ FAILED [${done + skipped + 1}/${allOrders.length}] ${o.seedId} ${c.firstName} ${c.lastName}: ${e.message}`);
      throw e;
    }
    done++;
    const elapsed = ((Date.now() - t0) / 60000).toFixed(1);
    log(`  ✓ [${done + skipped}/${allOrders.length}] ${o.seedId} ${c.firstName} ${c.lastName} — ${o.processedAt.slice(0, 10)} — ${((Date.now() - started) / 1000).toFixed(1)}s (${elapsed}min elapsed)`);
  }
  log(`\n${done} orders created, ${skipped} skipped, ${((Date.now() - t0) / 60000).toFixed(1)} min total\n`);
}

async function main() {
  const variantMap = resolveVariantIds();
  pushCustomers(dataset);
  // Unconditional: see fetchExistingSeedTags note above. --resume no longer
  // gates this — it always runs so a plain re-invocation after a crash is safe.
  const skipSet = fetchExistingSeedTags();
  await pushOrdersAsync(dataset, variantMap, skipSet);
  writeFileSync(DATA_FILE, JSON.stringify(dataset, null, 2)); // persist _shopifyId back
  log('Done. Run verification queries against the store to confirm final counts.');
}

main().catch((e) => {
  log(`\nFATAL: ${e.message}`);
  log(`FATAL stack: ${e.stack || '(no stack)'}`);
  process.exitCode = 1;
});
