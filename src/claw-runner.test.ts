import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// claw-runner spawns a real Rust subprocess and talks to Ollama. For unit
// tests we mock the process boundary (node:child_process) and the filesystem
// probe (node:fs) so we can drive the NDJSON event stream deterministically
// and assert on argv assembly, parsing, retry, timeout, and abort behavior
// without a binary or a GPU.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdtempSync: vi.fn(() => '/tmp/claw-ws-test'),
  mkdirSync: vi.fn(),
}));
vi.mock('./ollama.js', () => ({
  resolveOllamaBaseUrl: vi.fn(() => 'http://127.0.0.1:11434'),
}));
vi.mock('./ollama-prefix-proxy.js', () => ({
  PROXY_BASE_URL_V1: 'http://127.0.0.1:11435/v1',
}));
vi.mock('./config.js', () => ({ DASHBOARD_TOKEN: 'test-token' }));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { runClaw } from './claw-runner.js';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);

// A scriptable fake child process. `behavior` runs on a microtask AFTER spawn
// returns, so the runner's stdout/exit listeners are attached before we stream
// anything. kill() emulates the real binary exiting on SIGTERM so the runner's
// resolve fires when it kills the child (stray-XML / timeout / abort paths).
type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
  kill: ReturnType<typeof vi.fn>;
  _exit: (code: number | null, sig: string | null) => void;
  _behavior?: (c: FakeChild) => void;
};

function makeFakeChild(behavior?: (c: FakeChild) => void): FakeChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const child = new EventEmitter() as FakeChild;
  child.stdout = stdout;
  child.stderr = stderr;
  let exited = false;
  child._exit = (code, sig) => {
    if (exited) return;
    exited = true;
    child.emit('exit', code, sig);
  };
  child.kill = vi.fn(() => {
    queueMicrotask(() => child._exit(null, 'SIGTERM'));
  });
  child._behavior = behavior;
  return child;
}

function ndjson(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra }) + '\n';
}

let children: FakeChild[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  mockExistsSync.mockReturnValue(true);
  mockSpawn.mockImplementation(((..._args: unknown[]) => {
    const child = children.shift();
    if (!child) throw new Error('spawn called more times than queued children');
    queueMicrotask(() => child._behavior?.(child));
    return child as unknown as ReturnType<typeof spawn>;
  }) as typeof spawn);
});

describe('runClaw argv + env assembly', () => {
  it('returns a clear error and never spawns when the binary is missing', async () => {
    mockExistsSync.mockReturnValue(false);
    const res = await runClaw({ model: 'qwen3-coder:30b', task: 'hi', workspace: '/tmp/ws' });
    expect(res.error).toContain('claw binary not found');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('assembles claw-analog argv (workspace, model, no-stream, permission, max-turns, prompt)', async () => {
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('assistant_turn', { text: 'ok', stop_reason: 'end_turn' }));
      c._exit(0, null);
    }));
    await runClaw({
      model: 'qwen3-coder:30b',
      task: 'do the thing',
      workspace: '/tmp/ws',
      permission: 'read-only',
      maxTurns: 7,
    });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toEqual([
      '-w', '/tmp/ws',
      '--model', 'qwen3-coder:30b',
      '--output-format', 'json',
      '--no-stream',
      '--permission', 'read-only',
      '--max-turns', '7',
      'do the thing',
    ]);
  });

  it('assembles full-claw argv with provider-prefixed model, permission-mode, skip-permissions, prompt subcommand', async () => {
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', JSON.stringify({ message: 'done', iterations: 1, tool_uses: [], tool_results: [] }));
      c._exit(0, null);
    }));
    await runClaw({
      model: 'qwen3-coder:30b',
      task: 'analyze',
      workspace: '/tmp/ws',
      permission: 'workspace-write',
      useFullClaw: true,
    });
    const args = mockSpawn.mock.calls[0][1] as string[];
    const spawnOpts = mockSpawn.mock.calls[0][2] as { cwd?: string };
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('workspace-write');
    expect(args[args.indexOf('--model') + 1]).toBe('openai/qwen3-coder:30b');
    expect(args).toContain('prompt');
    expect(spawnOpts.cwd).toBe('/tmp/ws');
  });

  it('merges systemAddendum and task into a single trailing prompt arg, addendum first', async () => {
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('assistant_turn', { text: 'x' }));
      c._exit(0, null);
    }));
    await runClaw({ model: 'm', task: 'TASK_BODY', systemAddendum: 'SYS_PREFIX', workspace: '/tmp/ws' });
    const args = mockSpawn.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toContain('SYS_PREFIX');
    expect(prompt).toContain('TASK_BODY');
    expect(prompt.indexOf('SYS_PREFIX')).toBeLessThan(prompt.indexOf('TASK_BODY'));
  });
});

describe('runClaw NDJSON parsing', () => {
  it('parses a successful run: text, toolCalls, turns, stopReason, usage, and onProgress events', async () => {
    const events: Array<{ type: string; toolName?: string; toolUseId?: string }> = [];
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('run_start', { model: 'm', permission: 'read-only' }));
      c.stdout.emit('data', ndjson('turn_start', { turn: 1 }));
      c.stdout.emit('data', ndjson('assistant_turn', {
        text: 'Hello from claw',
        stop_reason: 'end_turn',
        tool_calls: [{ id: 't1', name: 'read_file', input: { path: '/x' } }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }));
      c.stdout.emit('data', ndjson('tool_result', { tool_use_id: 't1', output: 'contents' }));
      c.stdout.emit('data', ndjson('run_end', { ok: true }));
      c._exit(0, null);
    }));
    const res = await runClaw({
      model: 'm',
      task: 'read x',
      workspace: '/tmp/ws',
      onProgress: (e) => events.push(e),
    });
    expect(res.text).toBe('Hello from claw');
    expect(res.toolCalls).toBe(1);
    expect(res.turns).toBe(1);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage?.total_tokens).toBe(8);
    expect(res.error).toBeUndefined();
    expect(events.some((e) => e.type === 'tool_use' && e.toolName === 'read_file')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.toolUseId === 't1')).toBe(true);
  });

  it('surfaces a model-emitted error event as result.error', async () => {
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('error', { message: 'model refused' }));
      c._exit(0, null);
    }));
    const res = await runClaw({ model: 'm', task: 'go', workspace: '/tmp/ws' });
    expect(res.error).toBe('model refused');
  });
});

describe('runClaw retry policy', () => {
  it('retries once when the first run emits stray <function=...> tool syntax', async () => {
    children.push(makeFakeChild((c) => {
      // Stray OpenAI-XML the runner detects; it kills the child (kill auto-exits).
      c.stdout.emit('data', '<function=read_file>{"path":"/x"}</function>\n');
    }));
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('assistant_turn', { text: 'clean answer', stop_reason: 'end_turn' }));
      c._exit(0, null);
    }));
    const res = await runClaw({ model: 'qwen3-coder:30b', task: 'go', workspace: '/tmp/ws' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(res.text).toBe('clean answer');
    expect(res.retryAttempts).toBe(1);
    expect(res.strayToolSyntax).toBe(false);
  });

  it('retries once on an empty no-op run (no text, no tools, no error)', async () => {
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('run_end', { ok: true }));
      c._exit(0, null);
    }));
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('assistant_turn', { text: 'second try', stop_reason: 'end_turn' }));
      c._exit(0, null);
    }));
    const res = await runClaw({ model: 'm', task: 'go', workspace: '/tmp/ws' });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(res.text).toBe('second try');
    expect(res.retryAttempts).toBe(1);
  });

  it('does NOT retry a deterministic non-zero exit (surfaces stderr as error)', async () => {
    children.push(makeFakeChild((c) => {
      c.stderr.emit('data', 'boom: model crashed');
      c._exit(2, null);
    }));
    const res = await runClaw({ model: 'm', task: 'go', workspace: '/tmp/ws' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(res.error).toContain('boom: model crashed');
  });

  it('never retries an aborted run, even when it would otherwise be retryable', async () => {
    const ac = new AbortController();
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', '<function=read_file></function>\n'); // retryable on its own
      ac.abort();
      c._exit(null, 'SIGTERM');
    }));
    const res = await runClaw({ model: 'm', task: 'go', workspace: '/tmp/ws', signal: ac.signal });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(res.error).toBe('aborted');
  });

  it('kills and retries once on wall-clock timeout', async () => {
    children.push(makeFakeChild(() => {
      // Never exits on its own; the wall-clock timer must kill it.
    }));
    children.push(makeFakeChild((c) => {
      c.stdout.emit('data', ndjson('assistant_turn', { text: 'after timeout', stop_reason: 'end_turn' }));
      c._exit(0, null);
    }));
    const res = await runClaw({ model: 'm', task: 'go', workspace: '/tmp/ws', timeoutMs: 20 });
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(res.text).toBe('after timeout');
    expect(res.retryAttempts).toBe(1);
  });
});
