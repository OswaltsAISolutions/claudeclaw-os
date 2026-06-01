import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toasts, pushToast, dismissToast } from './toasts';

// toasts.ts is the global toast queue (info/success/warn/error, optional
// inline action, auto-dismiss). The contract worth pinning: a default 4s
// duration the caller can override, durationMs:0 meaning "persist until
// dismissed", auto-dismiss firing exactly at the duration, unique ids, and
// dismissToast removing only the matching toast. Fake timers make the
// auto-dismiss deterministic; we reset the queue (not the module-level id
// counter) between tests and assert id ordering rather than absolute values.

beforeEach(() => {
  vi.useFakeTimers();
  toasts.value = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('pushToast', () => {
  it('appends a toast and returns its id', () => {
    const id = pushToast({ tone: 'info', title: 'Hello', durationMs: 0 });
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0].id).toBe(id);
    expect(toasts.value[0].title).toBe('Hello');
    expect(toasts.value[0].tone).toBe('info');
  });

  it('applies the default 4s duration', () => {
    pushToast({ tone: 'info', title: 'x' });
    expect(toasts.value[0].durationMs).toBe(4000);
  });

  it('lets the caller override the duration', () => {
    pushToast({ tone: 'info', title: 'x', durationMs: 1000 });
    expect(toasts.value[0].durationMs).toBe(1000);
  });

  it('auto-dismisses exactly at the duration', () => {
    pushToast({ tone: 'info', title: 'x', durationMs: 1000 });
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(toasts.value).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts.value).toHaveLength(0);
  });

  it('keeps a durationMs:0 toast persistent', () => {
    pushToast({ tone: 'error', title: 'stay', durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(toasts.value).toHaveLength(1);
  });

  it('assigns increasing, unique ids in push order', () => {
    const a = pushToast({ tone: 'info', title: 'a', durationMs: 0 });
    const b = pushToast({ tone: 'info', title: 'b', durationMs: 0 });
    expect(b).toBeGreaterThan(a);
    expect(toasts.value.map((t) => t.id)).toEqual([a, b]);
  });
});

describe('dismissToast', () => {
  it('removes only the matching toast', () => {
    const a = pushToast({ tone: 'info', title: 'a', durationMs: 0 });
    const b = pushToast({ tone: 'info', title: 'b', durationMs: 0 });
    dismissToast(a);
    expect(toasts.value.map((t) => t.id)).toEqual([b]);
  });

  it('is a no-op for an unknown id', () => {
    pushToast({ tone: 'info', title: 'a', durationMs: 0 });
    dismissToast(999_999);
    expect(toasts.value).toHaveLength(1);
  });
});
