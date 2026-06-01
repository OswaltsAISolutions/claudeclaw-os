import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

// useFetch is the SWR data hook every page leans on. We mock the network
// boundary (apiGet) and the ApiError class it branches on, then drive the
// hook through a tiny harness so we assert the observable contract: the
// cold-start loading flash, error surfacing, the null-path no-op, manual
// refresh, the process-local cache (instant repaint, no flash on remount),
// the "never show another endpoint's data" path-change clear, and polling.
vi.mock('@/lib/api', () => {
  // Mirror the real constructor (status, body, message) so call sites
  // type-check against the imported class, not just at runtime.
  class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message);
    }
  }
  return { apiGet: vi.fn(), ApiError };
});

import { useFetch } from './useFetch';
import { apiGet, ApiError } from '@/lib/api';

function Harness({ path, pollMs }: { path: string | null; pollMs?: number }) {
  const { data, loading, error, refresh } = useFetch<{ v: number }>(path, pollMs);
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? ''}</span>
      <span data-testid="data">{data ? JSON.stringify(data) : ''}</span>
      <button type="button" onClick={refresh}>refresh</button>
    </div>
  );
}

const loadingText = () => screen.getByTestId('loading').textContent;
const dataText = () => screen.getByTestId('data').textContent;
const errorText = () => screen.getByTestId('error').textContent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFetch', () => {
  it('shows the cold-start loading flash, then the fetched payload', async () => {
    vi.mocked(apiGet).mockResolvedValue({ v: 7 });
    render(<Harness path="/api/cold" />);

    // Cold (uncached) path paints loading=true on the very first render.
    expect(loadingText()).toBe('true');

    await waitFor(() => expect(dataText()).toBe('{"v":7}'));
    expect(loadingText()).toBe('false');
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/api/cold');
  });

  it('surfaces an ApiError message and leaves data null', async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError(503, null, 'vault is sealed'));
    render(<Harness path="/api/err" />);

    await waitFor(() => expect(errorText()).toBe('vault is sealed'));
    expect(dataText()).toBe('');
    expect(loadingText()).toBe('false');
  });

  it('stringifies a non-ApiError rejection rather than dropping it', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('socket hangup'));
    render(<Harness path="/api/err2" />);

    await waitFor(() => expect(errorText()).toBe('Error: socket hangup'));
  });

  it('never fetches for a null path', async () => {
    render(<Harness path={null} />);
    expect(loadingText()).toBe('false');
    expect(dataText()).toBe('');
    expect(vi.mocked(apiGet)).not.toHaveBeenCalled();
  });

  it('re-fetches and updates when refresh() is called', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 });
    render(<Harness path="/api/refresh" />);

    await waitFor(() => expect(dataText()).toBe('{"v":1}'));
    fireEvent.click(screen.getByText('refresh'));

    await waitFor(() => expect(dataText()).toBe('{"v":2}'));
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(2);
  });

  it('hydrates from the process-local cache on remount with no loading flash', async () => {
    vi.mocked(apiGet).mockResolvedValue({ v: 42 });
    const first = render(<Harness path="/api/hydrate" />);
    await waitFor(() => expect(dataText()).toBe('{"v":42}'));
    first.unmount();

    // Second visit to the same endpoint paints cached data immediately,
    // with loading already false (the revalidate happens invisibly).
    render(<Harness path="/api/hydrate" />);
    expect(dataText()).toBe('{"v":42}');
    expect(loadingText()).toBe('false');
  });

  it('clears stale data immediately when the path changes to an uncached endpoint', async () => {
    vi.mocked(apiGet).mockImplementation((p: string) =>
      p === '/api/a' ? Promise.resolve({ v: 1 }) : new Promise(() => {}),
    );
    const { rerender } = render(<Harness path="/api/a" />);
    await waitFor(() => expect(dataText()).toBe('{"v":1}'));

    // /api/b is uncached and never resolves here; the hook must drop the
    // /api/a payload at once rather than render another endpoint's data.
    rerender(<Harness path="/api/b" />);
    await waitFor(() => expect(dataText()).toBe(''));
    expect(loadingText()).toBe('true');
  });

  it('re-fetches on the poll interval', async () => {
    vi.mocked(apiGet).mockResolvedValue({ v: 1 });
    render(<Harness path="/api/poll" pollMs={30} />);

    await waitFor(() => expect(vi.mocked(apiGet).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
