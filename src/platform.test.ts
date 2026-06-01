import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import {
  IS_WINDOWS,
  IS_MACOS,
  IS_LINUX,
  killProcess,
  isProcessAlive,
  findProcessesByPattern,
  getVenvPython,
  tmpDir,
  agentServiceLabel,
  claudeCodeHandoff,
} from './platform.js';

describe('platform flags', () => {
  it('reports exactly one platform as active', () => {
    const active = [IS_WINDOWS, IS_MACOS, IS_LINUX].filter(Boolean);
    expect(active).toHaveLength(1);
  });
});

describe('killProcess input guard', () => {
  // We only exercise the rejection guard — issuing a real kill would have
  // side effects on whatever process happened to own that PID.
  it('refuses non-positive and non-finite PIDs without throwing', () => {
    expect(killProcess(0)).toBe(false);
    expect(killProcess(-1)).toBe(false);
    expect(killProcess(NaN)).toBe(false);
    expect(killProcess(Infinity)).toBe(false);
  });
});

describe('isProcessAlive', () => {
  it('refuses invalid PIDs', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-5)).toBe(false);
    expect(isProcessAlive(NaN)).toBe(false);
  });

  it('reports the current process as alive', () => {
    // signal 0 (POSIX) / tasklist (Windows) just probes existence.
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports an almost-certainly-dead PID as not alive', () => {
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe('findProcessesByPattern', () => {
  it('resolves to an empty array for a pattern that matches nothing', async () => {
    const pids = await findProcessesByPattern('zzz-no-such-process-pattern-9182734');
    expect(pids).toEqual([]);
  });
});

describe('getVenvPython', () => {
  it('points at the platform-correct interpreter inside the venv', () => {
    const result = getVenvPython('/srv/app/.venv');
    const expected = IS_WINDOWS
      ? path.join('/srv/app/.venv', 'Scripts', 'python.exe')
      : path.join('/srv/app/.venv', 'bin', 'python');
    expect(result).toBe(expected);
  });
});

describe('tmpDir', () => {
  it('returns the OS temp directory', () => {
    expect(tmpDir()).toBe(os.tmpdir());
  });
});

describe('agentServiceLabel', () => {
  it('builds the com.claudeclaw.<id> service label', () => {
    expect(agentServiceLabel('ops')).toBe('com.claudeclaw.ops');
    expect(agentServiceLabel('main')).toBe('com.claudeclaw.main');
  });
});

describe('claudeCodeHandoff', () => {
  it('embeds the project root, failure description, error, and target file', () => {
    const text = claudeCodeHandoff({
      projectRoot: '/home/me/claudeclaw-os',
      what: 'schtasks registration',
      error: 'Access denied',
      file: 'src/scheduler.ts',
    });
    expect(text).toContain('/home/me/claudeclaw-os');
    expect(text).toContain('schtasks registration');
    expect(text).toContain('Access denied');
    expect(text).toContain('src/scheduler.ts');
  });

  it('uses the generic adapt-paths line when no file is given', () => {
    const text = claudeCodeHandoff({
      projectRoot: '/r',
      what: 'service registration',
    });
    expect(text).toContain('Adapt the Windows paths in this repo');
    expect(text).not.toContain('Start by reading');
  });
});
