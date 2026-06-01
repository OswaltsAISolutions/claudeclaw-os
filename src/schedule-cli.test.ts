import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, '..', 'dist', 'schedule-cli.js');
const PROJECT_DIR = path.resolve(__dirname, '..');

describe('schedule-cli agent routing', () => {
  // These tests run the actual CLI as a child process to verify env var
  // behavior. CLAUDECLAW_STORE_DIR points the child at a throwaway temp store
  // so the `create` calls never write into the real scheduler DB (which would
  // otherwise leave cron entries that could actually fire — these crons run
  // daily at 09:00 — if a run were interrupted before cleanup).
  let storeDir: string;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-cli-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function runCli(cmd: string, env: Record<string, string | undefined>): string {
    return execSync(cmd, {
      cwd: PROJECT_DIR,
      env: { ...env, CLAUDECLAW_STORE_DIR: storeDir },
      encoding: 'utf-8',
    });
  }

  it('auto-detects agent from CLAUDECLAW_AGENT_ID env var', () => {
    const result = runCli(
      `node "${CLI_PATH}" create "test auto-detect" "0 9 * * *"`,
      { ...process.env, CLAUDECLAW_AGENT_ID: 'comms' },
    );

    expect(result).toContain('Agent:        comms');
  });

  it('--agent flag overrides CLAUDECLAW_AGENT_ID env var', () => {
    const result = runCli(
      `node "${CLI_PATH}" create "test override" "0 9 * * *" --agent ops`,
      { ...process.env, CLAUDECLAW_AGENT_ID: 'comms' },
    );

    expect(result).toContain('Agent:        ops');
  });

  it('defaults to main when no env var and no --agent flag', () => {
    const result = runCli(
      `node "${CLI_PATH}" create "test default" "0 9 * * *"`,
      { ...process.env, CLAUDECLAW_AGENT_ID: undefined },
    );

    expect(result).toContain('Agent:        main');
  });
});
