// Regression test for the /customers 500: an unvalidated ?segment= (or a
// non-finite ?page=/?pageSize=) reaching Drizzle's eq()/.limit()/.offset()
// straight from a URL query string. A production build of GET
// /customers?segment=not_a_real_segment threw "invalid input value for enum
// segment_t" before this fix. lib/list-params.ts holds the pure validation
// (no server-only import, no DATABASE_URL needed) so it can be exercised
// here without a live database.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidSegment, normalizePage, normalizePageSize } from '../lib/list-params';
import { segmentT } from '../db/schema';

describe('isValidSegment', () => {
  it('accepts every real segment_t value', () => {
    for (const s of segmentT.enumValues) {
      assert.equal(isValidSegment(s), true, `expected ${s} to be valid`);
    }
    assert.equal(segmentT.enumValues.length, 11);
  });

  it('rejects a tampered/typo\'d segment instead of reaching the DB enum cast', () => {
    assert.equal(isValidSegment('not_a_real_segment'), false);
    assert.equal(isValidSegment(''), false);
    assert.equal(isValidSegment('Champions'), false); // case-sensitive
    assert.equal(isValidSegment("champions'; drop table customers; --"), false);
  });

  it('rejects "all", the list page\'s own sentinel for no filter', () => {
    // "all" is handled by the caller as "no filter"; isValidSegment itself
    // has no opinion on it and correctly says it isn't a real segment.
    assert.equal(isValidSegment('all'), false);
  });
});

describe('normalizePage', () => {
  it('passes through a normal page number', () => {
    assert.equal(normalizePage(3), 3);
  });

  it('falls back to 1 for undefined, NaN, zero, or negative', () => {
    assert.equal(normalizePage(undefined), 1);
    assert.equal(normalizePage(Number('not-a-number')), 1);
    assert.equal(normalizePage(0), 1);
    assert.equal(normalizePage(-5), 1);
  });

  it('floors a fractional page', () => {
    assert.equal(normalizePage(2.9), 2);
  });
});

describe('normalizePageSize', () => {
  it('passes through a normal page size', () => {
    assert.equal(normalizePageSize(25), 25);
  });

  it('falls back to the default for undefined, NaN, zero, or negative', () => {
    assert.equal(normalizePageSize(undefined), 25);
    assert.equal(normalizePageSize(Number('not-a-number')), 25);
    assert.equal(normalizePageSize(0), 25);
    assert.equal(normalizePageSize(-5), 25);
  });

  it('clamps an absurdly large page size to the max', () => {
    assert.equal(normalizePageSize(1_000_000), 100);
  });
});
