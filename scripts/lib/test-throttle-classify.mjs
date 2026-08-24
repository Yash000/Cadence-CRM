// Regression test for classifyGqlResponse's throttle detection.
//
// Context (task-2 review finding): the original THROTTLE_RE matched loose
// single words ("exceeded", "too many") against every mutation's
// userErrors, not just orderCreate's rate cap — an ordinary validation
// error like "Maximum quantity exceeded" would be misclassified as a
// throttle, retried 8x for ~2.7 minutes, then thrown as the literal string
// "THROTTLED" (discarding the real message). This test locks in the fix:
// narrow literal-phrase matching (confirmed against the real message
// observed live during the seed run) plus structured extensions.code
// detection for top-level GraphQL cost throttling, with the original
// error message always preserved.
//
//   node scripts/lib/test-throttle-classify.mjs

import { classifyGqlResponse } from './shopify.mjs';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`);
  else { failures++; console.log(`  FAIL - ${name}`); }
}

// 1. The real observed throttle userError: must be flagged AND keep its text.
{
  const data = {
    orderCreate: { order: null, userErrors: [{ field: [], message: 'Too many attempts. Please try again later.' }] },
  };
  const err = classifyGqlResponse(data);
  check('real orderCreate throttle -> err returned', !!err);
  check('real orderCreate throttle -> .throttled = true', err?.throttled === true);
  check('real orderCreate throttle -> original message preserved (not "THROTTLED")',
    err?.message === 'orderCreate:  Too many attempts. Please try again later.');
}

// 2. A genuine, non-throttle validation error containing "exceeded" — must
//    NOT be flagged, and must surface its real message immediately.
{
  const data = {
    orderCreate: { order: null, userErrors: [{ field: ['lineItems', '0', 'quantity'], message: 'Maximum quantity exceeded for this variant.' }] },
  };
  const err = classifyGqlResponse(data);
  check('non-throttle "exceeded" userError -> NOT flagged throttled', err?.throttled !== true);
  check('non-throttle "exceeded" userError -> original message preserved',
    err?.message === 'orderCreate: lineItems.0.quantity Maximum quantity exceeded for this variant.');
}

// 3. Another false-positive under the old regex: "too many line items".
{
  const data = { orderCreate: { order: null, userErrors: [{ field: [], message: 'Order has too many line items.' }] } };
  const err = classifyGqlResponse(data);
  check('"too many line items" -> NOT flagged throttled', err?.throttled !== true);
}

// 4. Structured top-level GraphQL cost-throttle shape (extensions.code).
{
  const data = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] };
  const err = classifyGqlResponse(data);
  check('structured top-level THROTTLED -> flagged', err?.throttled === true);
  check('structured top-level THROTTLED -> message preserved', err?.message === 'Throttled');
}

// 5. A genuine top-level GraphQL error unrelated to throttling.
{
  const data = { errors: [{ message: 'Field "foo" doesn\'t exist on type "Order"' }] };
  const err = classifyGqlResponse(data);
  check('unrelated top-level GraphQL error -> NOT flagged throttled', err?.throttled !== true);
}

// 6. Success case: no errors, no userErrors -> null.
{
  const data = { orderCreate: { order: { id: 'gid://shopify/Order/1' }, userErrors: [] } };
  check('clean success response -> null (no error)', classifyGqlResponse(data) === null);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
