import { describe, it, expect } from 'vitest';
import {
  safeTokenEqual,
  WARROOM_TEXT_ID_RE,
  CLIENT_MSG_ID_RE,
} from './dashboard.js';

// These three are the dashboard's input guards. safeTokenEqual is the
// constant-time auth comparison (audit fix A4E-1) every authenticated route
// funnels through; the two regexes validate meetingId / client message id on
// every route that accepts them, so they double as the path/format guard.
// The contract tests exercise auth over HTTP, these pin the primitives directly.

describe('safeTokenEqual', () => {
  it('returns false when either side is missing or empty', () => {
    expect(safeTokenEqual(null, 'tok')).toBe(false);
    expect(safeTokenEqual('tok', null)).toBe(false);
    expect(safeTokenEqual(undefined, 'tok')).toBe(false);
    expect(safeTokenEqual('tok', undefined)).toBe(false);
    expect(safeTokenEqual('', 'tok')).toBe(false);
    expect(safeTokenEqual('tok', '')).toBe(false);
    expect(safeTokenEqual('', '')).toBe(false);
    expect(safeTokenEqual(undefined, undefined)).toBe(false);
  });

  it('returns false when lengths differ (avoids a timingSafeEqual throw)', () => {
    // crypto.timingSafeEqual throws on differing buffer lengths; the explicit
    // length pre-check both prevents the throw and short-circuits safely.
    expect(safeTokenEqual('abc', 'ab')).toBe(false);
    expect(safeTokenEqual('ab', 'abc')).toBe(false);
  });

  it('returns true only for an exact match', () => {
    expect(safeTokenEqual('s3cret-token-123', 's3cret-token-123')).toBe(true);
  });

  it('returns false for same-length but different content', () => {
    expect(safeTokenEqual('aaaa', 'aaab')).toBe(false);
    expect(safeTokenEqual('s3cret-token-123', 's3cret-token-124')).toBe(false);
  });
});

describe('WARROOM_TEXT_ID_RE', () => {
  it('accepts the wr_<base36>_<hex> shape and its manual variants', () => {
    expect(WARROOM_TEXT_ID_RE.test('wr_lz4x_9f3a2b')).toBe(true);
    expect(WARROOM_TEXT_ID_RE.test('wr_abcd')).toBe(true); // 4-char minimum body
    expect(WARROOM_TEXT_ID_RE.test('WR_ABCD')).toBe(true); // case-insensitive
    expect(WARROOM_TEXT_ID_RE.test('wr_' + 'a'.repeat(64))).toBe(true); // 64-char max
  });

  it('rejects wrong prefixes, illegal chars, and out-of-range lengths', () => {
    expect(WARROOM_TEXT_ID_RE.test('wr_abc')).toBe(false); // body < 4
    expect(WARROOM_TEXT_ID_RE.test('wr_' + 'a'.repeat(65))).toBe(false); // body > 64
    expect(WARROOM_TEXT_ID_RE.test('xr_abcd')).toBe(false); // wrong prefix
    expect(WARROOM_TEXT_ID_RE.test('wr_ab-cd')).toBe(false); // hyphen not allowed
    expect(WARROOM_TEXT_ID_RE.test('wr_ab cd')).toBe(false); // space
    expect(WARROOM_TEXT_ID_RE.test('../wr_abcd')).toBe(false); // traversal attempt
    expect(WARROOM_TEXT_ID_RE.test('')).toBe(false);
  });
});

describe('CLIENT_MSG_ID_RE', () => {
  it('accepts a v4 UUID in either case', () => {
    expect(CLIENT_MSG_ID_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(CLIENT_MSG_ID_RE.test('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('rejects wrong version, wrong variant, and non-UUID strings', () => {
    // version nibble must be 4
    expect(CLIENT_MSG_ID_RE.test('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
    // variant nibble must be 8/9/a/b
    expect(CLIENT_MSG_ID_RE.test('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
    expect(CLIENT_MSG_ID_RE.test('not-a-uuid')).toBe(false);
    expect(CLIENT_MSG_ID_RE.test('550e8400e29b41d4a716446655440000')).toBe(false); // no dashes
    expect(CLIENT_MSG_ID_RE.test('')).toBe(false);
  });
});
