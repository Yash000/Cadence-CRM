// Seeds discount codes on rasaya-dev (task-9-brief.md), plus the codes that
// scripts/seed-supabase.mjs already baked into the seeded order history's
// discount_codes[] column (branch review finding: only WELCOME10 existed on
// both the store and the seeded orders — a live demo order using any of the
// other four codes the seed already "used" would fail on the real store):
//
//   WELCOME10  — 10% off, first order        (appliesOncePerCustomer: true)
//   COMEBACK15 — 15% off, win-back            (appliesOncePerCustomer: true)
//   REFILL20   — 20% off, replenishment       (appliesOncePerCustomer: false —
//                a customer refilling a consumable is expected to reuse it)
//   WINBACK15  — 15% off, win-back            (appliesOncePerCustomer: true —
//                same intent as COMEBACK15, matches seed-supabase.mjs's code)
//   HOMESTYLE5 — 5% off, general              (appliesOncePerCustomer: false)
//   FESTIVE20  — 20% off, festive/seasonal    (appliesOncePerCustomer: false —
//                seed-supabase.mjs marks it festiveOnly, not per-customer)
//   DIWALI15   — 15% off, festive/seasonal    (appliesOncePerCustomer: false)
//
//   node scripts/seed-discounts.mjs [--dry-run]
//
// Re-runnable: lists existing codeDiscountNodes first and skips any title
// already present, so a second run is a no-op rather than a duplicate.
import { readFileSync } from 'node:fs';
import { gqlWithBackoff, gql } from './lib/shopify.mjs';

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has('--dry-run');

const CREATE_MUTATION = readFileSync(new URL('./gql/discount-code-create.graphql', import.meta.url), 'utf8');
const LIST_QUERY = readFileSync(new URL('./gql/list-discount-codes.graphql', import.meta.url), 'utf8');

const NOW = new Date().toISOString();

const DISCOUNTS = [
  {
    title: 'Welcome — 10% off first order',
    code: 'WELCOME10',
    percentage: 0.10,
    appliesOncePerCustomer: true,
  },
  {
    title: 'Comeback — 15% win-back',
    code: 'COMEBACK15',
    percentage: 0.15,
    appliesOncePerCustomer: true,
  },
  {
    title: 'Complete the room — 20% off the next piece',
    code: 'COMPLETE20',
    percentage: 0.20,
    appliesOncePerCustomer: false,
  },
  {
    title: 'Win-back — 15% off',
    code: 'WINBACK15',
    percentage: 0.15,
    appliesOncePerCustomer: true,
  },
  {
    title: 'HomeStyle — 5% general',
    code: 'HOMESTYLE5',
    percentage: 0.05,
    appliesOncePerCustomer: false,
  },
  {
    title: 'Festive — 20% seasonal',
    code: 'FESTIVE20',
    percentage: 0.20,
    appliesOncePerCustomer: false,
  },
  {
    title: 'Diwali — 15% seasonal',
    code: 'DIWALI15',
    percentage: 0.15,
    appliesOncePerCustomer: false,
  },
];

function buildInput(d) {
  return {
    title: d.title,
    code: d.code,
    startsAt: NOW,
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: d.percentage },
      items: { all: true },
    },
    appliesOncePerCustomer: d.appliesOncePerCustomer,
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: false,
    },
  };
}

async function existingCodes() {
  const data = gql(LIST_QUERY);
  return new Set(
    data.codeDiscountNodes.edges
      .map((e) => e.node.codeDiscount?.codes?.nodes?.[0]?.code)
      .filter(Boolean),
  );
}

async function main() {
  console.log(`seeding discount codes on rasaya-dev${DRY_RUN ? ' (dry run)' : ''}\n`);

  const already = await existingCodes();

  for (const d of DISCOUNTS) {
    if (already.has(d.code)) {
      console.log(`skip  ${d.code} — already exists on the store`);
      continue;
    }
    console.log(`create ${d.code} — ${(d.percentage * 100).toFixed(0)}% (${d.title})`);
    if (DRY_RUN) continue;

    const data = await gqlWithBackoff(CREATE_MUTATION, { basicCodeDiscount: buildInput(d) });
    const created = data.discountCodeBasicCreate.codeDiscountNode;
    const code = created?.codeDiscount?.codes?.nodes?.[0]?.code;
    console.log(`  ✓ ${created?.id} code=${code}`);
  }

  console.log(DRY_RUN ? '\ndry run complete — nothing written' : '\ndone');
}

main().catch((err) => {
  console.error('\nFATAL:', err?.stack || err);
  process.exit(1);
});
