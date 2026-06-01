import { describe, it, expect, afterEach, vi } from 'vitest';
import { messageQueue } from './message-queue.js';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The queue is a process-wide singleton. Each test uses unique chat ids and
// this hook waits for everything to drain, so no pending work leaks across
// tests (cleanup deletes a chat's entry once its last handler settles).
afterEach(async () => {
  await vi.waitFor(() => expect(messageQueue.activeChats).toBe(0));
});

describe('messageQueue', () => {
  it('runs handlers for the same chat sequentially in FIFO order', async () => {
    const order: number[] = [];
    messageQueue.enqueue('fifo', async () => {
      order.push(1);
      await delay(10);
      order.push(2);
    });
    messageQueue.enqueue('fifo', async () => {
      order.push(3);
    });

    await vi.waitFor(() => expect(messageQueue.activeChats).toBe(0));
    // If the second handler ran in parallel it would interleave as [1,3,2];
    // sequential FIFO means it waits for the first to fully finish.
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs handlers for different chats in parallel', async () => {
    const order: string[] = [];
    messageQueue.enqueue('slow', async () => {
      order.push('slow-start');
      await delay(20);
      order.push('slow-end');
    });
    messageQueue.enqueue('fast', async () => {
      order.push('fast-start');
      await delay(2);
      order.push('fast-end');
    });

    await vi.waitFor(() => expect(messageQueue.activeChats).toBe(0));
    // The fast chat should finish before the slow one does: proves they are
    // not serialized against each other.
    expect(order.indexOf('fast-end')).toBeLessThan(order.indexOf('slow-end'));
  });

  it('tracks pending counts synchronously on enqueue', () => {
    messageQueue.enqueue('counts', async () => {
      await delay(10);
    });
    messageQueue.enqueue('counts', async () => {
      await delay(10);
    });
    // pending is bumped synchronously, before any handler microtask runs.
    expect(messageQueue.queuedFor('counts')).toBe(2);
    expect(messageQueue.activeChats).toBe(1);
  });

  it('clears its bookkeeping once a chat fully drains', async () => {
    messageQueue.enqueue('drain', async () => {
      await delay(5);
    });
    expect(messageQueue.queuedFor('drain')).toBe(1);

    await vi.waitFor(() => expect(messageQueue.activeChats).toBe(0));
    expect(messageQueue.queuedFor('drain')).toBe(0);
  });

  it('isolates a throwing handler so the next one still runs', async () => {
    const order: number[] = [];
    messageQueue.enqueue('resilient', async () => {
      order.push(1);
      throw new Error('handler blew up');
    });
    messageQueue.enqueue('resilient', async () => {
      order.push(2);
    });

    await vi.waitFor(() => expect(messageQueue.activeChats).toBe(0));
    expect(order).toEqual([1, 2]);
  });

  it('reports zero queued for a chat it has never seen', () => {
    expect(messageQueue.queuedFor('never-touched')).toBe(0);
  });
});
