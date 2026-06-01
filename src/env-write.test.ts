import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { atomicEnvWrite, setEnvKey } from './env-write.js';
import { readEnvFile } from './env.js';

// Own temp dir, distinct from env.test.ts, so the two files never race on
// the same path when vitest runs them in parallel workers.
const TMP_DIR = '/tmp/claudeclaw-envwrite-test';
const TMP_ENV = path.join(TMP_DIR, '.env');

function freshDir(): void {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function readRaw(): string {
  return fs.readFileSync(TMP_ENV, 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('atomicEnvWrite', () => {
  it('round-trips arbitrary content to the given path', () => {
    freshDir();
    atomicEnvWrite(TMP_ENV, 'A=1\nB=2\n');
    expect(readRaw()).toBe('A=1\nB=2\n');
  });

  it('overwrites an existing file in full (no merge, no append)', () => {
    freshDir();
    fs.writeFileSync(TMP_ENV, 'OLD=stale\nLEFTOVER=x\n');
    atomicEnvWrite(TMP_ENV, 'NEW=fresh\n');
    expect(readRaw()).toBe('NEW=fresh\n');
  });

  it('writes the secrets file as 0o600 (owner-only)', () => {
    freshDir();
    atomicEnvWrite(TMP_ENV, 'TOKEN=secret\n');
    const mode = fs.statSync(TMP_ENV).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no .tmp sibling behind (rename consumes it)', () => {
    freshDir();
    atomicEnvWrite(TMP_ENV, 'A=1\n');
    const leftovers = fs.readdirSync(TMP_DIR).filter((f) => f.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });
});

describe('setEnvKey', () => {
  it('appends a key when the file does not exist yet', () => {
    freshDir(); // dir exists, .env does not
    setEnvKey(TMP_ENV, 'KEY', 'value');
    expect(readRaw()).toContain('KEY=value');
    // The reader, pointed at this dir, sees exactly what we set.
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
    expect(readEnvFile(['KEY'])).toEqual({ KEY: 'value' });
  });

  it('replaces an existing key in place, preserving order and other lines', () => {
    freshDir();
    fs.writeFileSync(TMP_ENV, 'A=old\nB=2');
    setEnvKey(TMP_ENV, 'A', 'new');
    expect(readRaw()).toBe('A=new\nB=2');
  });

  it('preserves comments and blank lines when replacing', () => {
    freshDir();
    fs.writeFileSync(TMP_ENV, '# header\nA=old\n\n# tail\nB=2');
    setEnvKey(TMP_ENV, 'A', 'new');
    expect(readRaw()).toBe('# header\nA=new\n\n# tail\nB=2');
  });

  it('replaces only the first occurrence of a duplicated key', () => {
    freshDir();
    fs.writeFileSync(TMP_ENV, 'A=1\nA=2');
    setEnvKey(TMP_ENV, 'A', '9');
    expect(readRaw()).toBe('A=9\nA=2');
  });

  it('does not clobber a prefix-colliding key (AB vs ABC)', () => {
    freshDir();
    fs.writeFileSync(TMP_ENV, 'ABC=9');
    setEnvKey(TMP_ENV, 'AB', 'x');
    // ABC is untouched; AB is added as a new key.
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
    expect(readEnvFile(['AB', 'ABC'])).toEqual({ AB: 'x', ABC: '9' });
  });

  it('round-trips through the reader: last write wins on update', () => {
    freshDir();
    setEnvKey(TMP_ENV, 'TOKEN', 'first');
    setEnvKey(TMP_ENV, 'TOKEN', 'second');
    vi.spyOn(process, 'cwd').mockReturnValue(TMP_DIR);
    expect(readEnvFile(['TOKEN'])).toEqual({ TOKEN: 'second' });
  });
});
