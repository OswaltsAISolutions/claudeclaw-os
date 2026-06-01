import { describe, it, expect } from 'vitest';
import {
  stripRoutingPrefix,
  isQwen3Family,
  stripThinkingTags,
  stripFromContent,
  processSseLine,
} from './ollama-prefix-proxy.js';

// The prefix proxy is the only thing standing between full `claw` and local
// Ollama: it strips claw's routing prefix so Ollama recognises the bare model
// id, and it scrubs Qwen3 <think>...</think> reasoning blocks so specialists
// emit a real answer instead of a thinking buffer. All five helpers are pure
// (the streaming ones take their state via closures), so the strip rules that
// make local specialists usable are worth pinning exactly.

describe('stripRoutingPrefix', () => {
  it('returns an empty string untouched', () => {
    expect(stripRoutingPrefix('')).toBe('');
  });

  it('leaves a bare model id (no slash) unchanged', () => {
    expect(stripRoutingPrefix('qwen3-coder:30b')).toBe('qwen3-coder:30b');
  });

  it('strips every known routing prefix', () => {
    expect(stripRoutingPrefix('openai/qwen3-coder:30b')).toBe('qwen3-coder:30b');
    expect(stripRoutingPrefix('xai/grok-2')).toBe('grok-2');
    expect(stripRoutingPrefix('grok/foo')).toBe('foo');
    expect(stripRoutingPrefix('qwen/bar')).toBe('bar');
    expect(stripRoutingPrefix('kimi/baz')).toBe('baz');
  });

  it('matches the prefix case-insensitively', () => {
    expect(stripRoutingPrefix('OpenAI/Model')).toBe('Model');
    expect(stripRoutingPrefix('XAI/grok')).toBe('grok');
  });

  it('strips only the first segment when the prefix is known', () => {
    // slash splits once: prefix "openai" is known, the rest is returned whole.
    expect(stripRoutingPrefix('openai/a/b')).toBe('a/b');
  });

  it('preserves an unknown prefix verbatim (incl. multi-segment ids)', () => {
    expect(stripRoutingPrefix('unknown/model')).toBe('unknown/model');
    // huihui_ai is NOT a routing prefix, so abliterated slugs are left intact.
    expect(stripRoutingPrefix('huihui_ai/Qwen3.6-abliterated:35b')).toBe(
      'huihui_ai/Qwen3.6-abliterated:35b',
    );
  });
});

describe('isQwen3Family', () => {
  it('detects qwen3 anywhere in the name, case-insensitively', () => {
    expect(isQwen3Family('qwen3-coder:30b')).toBe(true);
    expect(isQwen3Family('Qwen3.6-abliterated:35b')).toBe(true);
    expect(isQwen3Family('huihui_ai/Qwen3-abliterated')).toBe(true);
  });

  it('returns false for non-qwen3 models', () => {
    expect(isQwen3Family('qwen2.5-coder')).toBe(false);
    expect(isQwen3Family('mistral')).toBe(false);
    expect(isQwen3Family('')).toBe(false);
  });
});

describe('stripThinkingTags', () => {
  it('returns falsy input untouched', () => {
    expect(stripThinkingTags('')).toBe('');
  });

  it('leaves content without thinking tags unchanged', () => {
    expect(stripThinkingTags('just the answer')).toBe('just the answer');
  });

  it('removes a closed think block and the whitespace after it', () => {
    expect(stripThinkingTags('<think>reasoning</think>\n\nanswer')).toBe('answer');
  });

  it('removes a think block embedded between real content', () => {
    expect(stripThinkingTags('before<think>mid</think>after')).toBe('beforeafter');
  });

  it('removes multiple closed think blocks', () => {
    expect(stripThinkingTags('<think>a</think>X<think>b</think>Y')).toBe('XY');
  });

  it('drops an unclosed think block that never resolves', () => {
    expect(stripThinkingTags('<think>endless reasoning with no close')).toBe('');
  });

  it('is case-insensitive about the tag name', () => {
    expect(stripThinkingTags('<THINK>x</THINK>answer')).toBe('answer');
  });
});

// stripFromContent and processSseLine carry <think> open/close state across
// fragments via getInside/setInside closures (a thinking block can be split
// across many SSE packets). This wrapper threads a single mutable flag so the
// tests can assert both the emitted text and the resulting state.
function runStrip(content: string, startInside = false): { out: string; inside: boolean } {
  let inside = startInside;
  const out = stripFromContent(content, () => inside, (v) => { inside = v; });
  return { out, inside };
}

describe('stripFromContent', () => {
  it('passes through content when not inside a think block', () => {
    expect(runStrip('hello world')).toEqual({ out: 'hello world', inside: false });
  });

  it('opens a think block mid-fragment and stays inside across the boundary', () => {
    expect(runStrip('visible <think>secret reasoning')).toEqual({
      out: 'visible ',
      inside: true,
    });
  });

  it('closes a think block that started in a previous fragment', () => {
    expect(runStrip('still thinking</think>answer', true)).toEqual({
      out: 'answer',
      inside: false,
    });
  });

  it('opens and closes within a single fragment', () => {
    expect(runStrip('a<think>b</think>c')).toEqual({ out: 'ac', inside: false });
  });

  it('handles several think blocks in one fragment', () => {
    expect(runStrip('x<think>1</think>y<think>2</think>z')).toEqual({
      out: 'xyz',
      inside: false,
    });
  });

  it('emits nothing and stays inside when a block never closes', () => {
    expect(runStrip('more thinking, no closer', true)).toEqual({ out: '', inside: true });
  });
});

// processSseLine parses one SSE line; data: payloads have their delta/message
// content scrubbed, everything else passes through verbatim. Parse the JSON
// back out of the returned line so assertions don't depend on key order.
function sseContent(line: string): string | undefined {
  const payload = line.replace(/^data:\s*/, '');
  const obj = JSON.parse(payload) as {
    choices?: Array<{ delta?: { content?: string } }>;
    message?: { content?: string };
  };
  return obj.choices?.[0]?.delta?.content ?? obj.message?.content;
}

function runSse(line: string, startInside = false): { out: string; inside: boolean } {
  let inside = startInside;
  const out = processSseLine(line, () => inside, (v) => { inside = v; });
  return { out, inside };
}

describe('processSseLine', () => {
  it('passes non-data lines through unchanged', () => {
    expect(runSse('event: ping').out).toBe('event: ping');
    expect(runSse('').out).toBe('');
  });

  it('passes the [DONE] sentinel and empty payloads through unchanged', () => {
    expect(runSse('data: [DONE]').out).toBe('data: [DONE]');
    expect(runSse('data: ').out).toBe('data: ');
  });

  it('passes a non-JSON data payload through unchanged', () => {
    expect(runSse('data: not json at all').out).toBe('data: not json at all');
  });

  it('leaves a clean OpenAI-compat delta chunk unchanged', () => {
    const line = 'data: {"choices":[{"delta":{"content":"hello"}}]}';
    const { out, inside } = runSse(line);
    expect(out).toBe(line);
    expect(inside).toBe(false);
  });

  it('scrubs an opening think block from a delta chunk and propagates state', () => {
    const { out, inside } = runSse('data: {"choices":[{"delta":{"content":"<think>reason"}}]}');
    expect(sseContent(out)).toBe('');
    expect(inside).toBe(true);
  });

  it('emits only the post-think content when the block closes in a later chunk', () => {
    const { out, inside } = runSse(
      'data: {"choices":[{"delta":{"content":"tail</think>visible"}}]}',
      true,
    );
    expect(sseContent(out)).toBe('visible');
    expect(inside).toBe(false);
  });

  it('scrubs think tags from the Ollama-native message.content shape', () => {
    const { out } = runSse('data: {"message":{"content":"<think>x</think>ok"}}');
    expect(sseContent(out)).toBe('ok');
  });
});
