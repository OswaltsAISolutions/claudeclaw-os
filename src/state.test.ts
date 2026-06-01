import { describe, it, expect, afterEach } from 'vitest';
import {
  setBotInfo,
  getBotInfo,
  setTelegramConnected,
  getTelegramConnected,
  chatEvents,
  emitChatEvent,
  setProcessing,
  getIsProcessing,
  setActiveAbort,
  abortActiveQuery,
  abortByPrefix,
  type ChatEvent,
} from './state.js';

// emitChatEvent / setProcessing fan out through the shared chatEvents
// emitter; drop our listeners after each test so they don't accumulate or
// fire into the next test.
afterEach(() => {
  chatEvents.removeAllListeners('chat');
});

describe('bot info', () => {
  it('round-trips username and name', () => {
    setBotInfo('GCruiseJarvisBot', 'Jarvis');
    expect(getBotInfo()).toEqual({ username: 'GCruiseJarvisBot', name: 'Jarvis' });
  });
});

describe('telegram connection flag', () => {
  it('round-trips the connected state', () => {
    setTelegramConnected(true);
    expect(getTelegramConnected()).toBe(true);
    setTelegramConnected(false);
    expect(getTelegramConnected()).toBe(false);
  });
});

describe('emitChatEvent', () => {
  it('stamps a timestamp and forwards the payload to chat listeners', () => {
    const received: ChatEvent[] = [];
    chatEvents.on('chat', (e: ChatEvent) => received.push(e));

    const before = Date.now();
    emitChatEvent({ type: 'user_message', chatId: 'c1', content: 'hello' });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('user_message');
    expect(received[0].chatId).toBe('c1');
    expect(received[0].content).toBe('hello');
    expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('processing state', () => {
  it('sets the flag, records the chat, and emits a processing event', () => {
    const received: ChatEvent[] = [];
    chatEvents.on('chat', (e: ChatEvent) => received.push(e));

    setProcessing('c2', true);
    expect(getIsProcessing()).toEqual({ processing: true, chatId: 'c2' });
    expect(
      received.some((e) => e.type === 'processing' && e.processing === true && e.chatId === 'c2'),
    ).toBe(true);
  });

  it('clears the chat id when processing turns off', () => {
    setProcessing('c2', false);
    expect(getIsProcessing()).toEqual({ processing: false, chatId: '' });
  });
});

describe('active query abort', () => {
  it('aborts a registered controller exactly once', () => {
    const ctrl = new AbortController();
    setActiveAbort('chatA', ctrl);
    expect(ctrl.signal.aborted).toBe(false);

    expect(abortActiveQuery('chatA')).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);

    // It was removed on abort, so a second call finds nothing.
    expect(abortActiveQuery('chatA')).toBe(false);
  });

  it('unregisters a controller when set to null', () => {
    const ctrl = new AbortController();
    setActiveAbort('chatB', ctrl);
    setActiveAbort('chatB', null);
    expect(abortActiveQuery('chatB')).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('returns false for a chat with no active query', () => {
    expect(abortActiveQuery('never-registered')).toBe(false);
  });
});

describe('abortByPrefix', () => {
  it('aborts and clears every controller whose key matches the prefix', () => {
    const ops = new AbortController();
    const comms = new AbortController();
    const unrelated = new AbortController();
    setActiveAbort('meet:42:ops', ops);
    setActiveAbort('meet:42:comms', comms);
    setActiveAbort('meet:99:ops', unrelated);

    expect(abortByPrefix('meet:42:')).toBe(2);
    expect(ops.signal.aborted).toBe(true);
    expect(comms.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);

    // Matched controllers were removed; the unrelated one survives.
    expect(abortActiveQuery('meet:42:ops')).toBe(false);
    expect(abortActiveQuery('meet:99:ops')).toBe(true);
  });

  it('returns 0 when no key matches', () => {
    expect(abortByPrefix('no-such-prefix:')).toBe(0);
  });
});
