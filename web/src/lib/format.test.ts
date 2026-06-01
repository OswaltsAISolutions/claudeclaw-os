import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatRelativeTime,
  formatDuration,
  formatNumber,
  formatCost,
  safeJsonArray,
} from './format';

// Pure display formatters used across pages. Behavior pinned by tracing the
// source, including the quirks (toFixed rounding, the .0 strip, the <$0.01
// cost floor) so a future tweak surfaces them instead of silently shifting
// every number on screen.

describe('formatRelativeTime', () => {
  const NOW_SEC = 1_700_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports seconds under a minute', () => {
    expect(formatRelativeTime(NOW_SEC - 5)).toBe('5s ago');
  });

  it('clamps a future timestamp to "0s ago"', () => {
    expect(formatRelativeTime(NOW_SEC + 100)).toBe('0s ago');
  });

  it('steps up through minutes, hours and days', () => {
    expect(formatRelativeTime(NOW_SEC - 120)).toBe('2m ago');
    expect(formatRelativeTime(NOW_SEC - 7200)).toBe('2h ago');
    expect(formatRelativeTime(NOW_SEC - 86400 * 2)).toBe('2d ago');
  });

  it('steps up through weeks, months and years', () => {
    expect(formatRelativeTime(NOW_SEC - 86400 * 14)).toBe('2w ago');
    expect(formatRelativeTime(NOW_SEC - 86400 * 60)).toBe('2mo ago');
    expect(formatRelativeTime(NOW_SEC - 86400 * 800)).toBe('2y ago');
  });

  it('treats the 60s boundary as minutes', () => {
    expect(formatRelativeTime(NOW_SEC - 60)).toBe('1m ago');
  });
});

describe('formatDuration', () => {
  it('shows whole seconds under a minute', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('floors to whole minutes under an hour', () => {
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3599)).toBe('59m');
  });

  it('shows one decimal of hours under a day', () => {
    expect(formatDuration(3600)).toBe('1.0h');
    expect(formatDuration(5400)).toBe('1.5h');
  });

  it('shows one decimal of days at a day and beyond', () => {
    expect(formatDuration(86400)).toBe('1.0d');
    expect(formatDuration(172800)).toBe('2.0d');
  });
});

describe('formatNumber', () => {
  it('passes through values under 1000', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('abbreviates thousands and strips a trailing .0', () => {
    expect(formatNumber(1000)).toBe('1k');
    expect(formatNumber(1500)).toBe('1.5k');
    expect(formatNumber(1999)).toBe('2k'); // toFixed(1) rounds 1.999 -> 2.0 -> 2
    expect(formatNumber(999999)).toBe('1000k'); // stays in the k band below 1e6
  });

  it('abbreviates millions', () => {
    expect(formatNumber(1_000_000)).toBe('1M');
    expect(formatNumber(2_500_000)).toBe('2.5M');
  });
});

describe('formatCost', () => {
  it('renders an exact zero as $0', () => {
    expect(formatCost(0)).toBe('$0');
  });

  it('floors tiny positive costs to <$0.01', () => {
    expect(formatCost(0.005)).toBe('<$0.01');
    expect(formatCost(0.009999)).toBe('<$0.01');
  });

  it('shows two decimals at and above a cent', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.5)).toBe('$0.50');
    expect(formatCost(1)).toBe('$1.00');
    expect(formatCost(12.345)).toBe('$12.35');
  });
});

describe('safeJsonArray', () => {
  it('returns [] for empty / nullish input', () => {
    expect(safeJsonArray(null)).toEqual([]);
    expect(safeJsonArray(undefined)).toEqual([]);
    expect(safeJsonArray('')).toEqual([]);
  });

  it('parses a JSON array', () => {
    expect(safeJsonArray('[1,2,3]')).toEqual([1, 2, 3]);
    expect(safeJsonArray('["a","b"]')).toEqual(['a', 'b']);
    expect(safeJsonArray('[]')).toEqual([]);
  });

  it('returns [] for valid JSON that is not an array', () => {
    expect(safeJsonArray('{"x":1}')).toEqual([]);
    expect(safeJsonArray('42')).toEqual([]);
    expect(safeJsonArray('null')).toEqual([]);
  });

  it('returns [] for malformed JSON instead of throwing', () => {
    expect(safeJsonArray('not json')).toEqual([]);
    expect(safeJsonArray('[1,2,')).toEqual([]);
  });
});
