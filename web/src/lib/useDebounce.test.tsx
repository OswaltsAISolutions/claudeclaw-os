import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/preact';
import { useDebouncedValue } from './useDebounce';

// useDebouncedValue delays propagating a changing value until it has been
// stable for delayMs, resetting the timer on every change (search inputs,
// resize handlers). Fake timers make the delay deterministic; the reset
// case proves an intermediate value never lands because its timer is
// cleared when the next change arrives.
function Harness({ value, delay }: { value: string; delay: number }) {
  const debounced = useDebouncedValue(value, delay);
  return <span data-testid="v">{debounced}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('returns the initial value immediately', () => {
    const { getByTestId } = render(<Harness value="a" delay={100} />);
    expect(getByTestId('v').textContent).toBe('a');
  });

  it('propagates a new value only after the delay elapses', () => {
    const { rerender, getByTestId } = render(<Harness value="a" delay={100} />);
    rerender(<Harness value="b" delay={100} />);
    expect(getByTestId('v').textContent).toBe('a');
    act(() => { vi.advanceTimersByTime(99); });
    expect(getByTestId('v').textContent).toBe('a');
    act(() => { vi.advanceTimersByTime(1); });
    expect(getByTestId('v').textContent).toBe('b');
  });

  it('resets the timer on rapid changes so only the final value lands', () => {
    const { rerender, getByTestId } = render(<Harness value="a" delay={100} />);
    rerender(<Harness value="b" delay={100} />);
    act(() => { vi.advanceTimersByTime(50); });
    rerender(<Harness value="c" delay={100} />);
    act(() => { vi.advanceTimersByTime(50); });
    expect(getByTestId('v').textContent).toBe('a'); // b's timer was cleared
    act(() => { vi.advanceTimersByTime(50); });
    expect(getByTestId('v').textContent).toBe('c'); // jumps straight to c
  });
});
