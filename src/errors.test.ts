import { describe, it, expect } from 'vitest';
import { classifyError, AgentError } from './errors.js';

describe('classifyError', () => {
  // ── Category detection ──────────────────────────────────────────────

  it('classifies rate limit errors', () => {
    const err = new Error('Request failed: 429 Too Many Requests');
    const classified = classifyError(err);
    expect(classified).toBeInstanceOf(AgentError);
    expect(classified.category).toBe('rate_limit');
    expect(classified.recovery.shouldRetry).toBe(true);
    expect(classified.recovery.retryAfterMs).toBeGreaterThan(0);
  });

  it('classifies rate limit from "rate limit" text', () => {
    const classified = classifyError(new Error('rate limit exceeded'));
    expect(classified.category).toBe('rate_limit');
  });

  it('classifies rate limit from "throttled" text', () => {
    const classified = classifyError(new Error('request throttled'));
    expect(classified.category).toBe('rate_limit');
  });

  it('classifies authentication errors', () => {
    const err = new Error('unauthorized: invalid api key');
    const classified = classifyError(err);
    expect(classified.category).toBe('auth');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.userMessage).toContain('claude login');
  });

  it('classifies OAuth token expired as auth', () => {
    const classified = classifyError(new Error('OAuth token expired'));
    expect(classified.category).toBe('auth');
  });

  it('classifies billing errors', () => {
    const err = new Error('402 Payment Required: insufficient credits');
    const classified = classifyError(err);
    expect(classified.category).toBe('billing');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('classifies overloaded errors', () => {
    const err = new Error('529 overloaded');
    const classified = classifyError(err);
    expect(classified.category).toBe('overloaded');
    expect(classified.recovery.shouldRetry).toBe(true);
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('classifies 503 service unavailable as overloaded', () => {
    const classified = classifyError(new Error('503 Service Unavailable'));
    expect(classified.category).toBe('overloaded');
  });

  it('classifies network errors', () => {
    const err = new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    const classified = classifyError(err);
    expect(classified.category).toBe('network');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies ECONNREFUSED as network', () => {
    const classified = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    expect(classified.category).toBe('network');
  });

  it('classifies timeout errors', () => {
    const err = new Error('Request timed out after 30000ms');
    const classified = classifyError(err);
    expect(classified.category).toBe('timeout');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  it('classifies context length errors', () => {
    const err = new Error('maximum context length exceeded');
    const classified = classifyError(err);
    expect(classified.category).toBe('context_exhausted');
    expect(classified.recovery.shouldNewChat).toBe(true);
    expect(classified.recovery.shouldRetry).toBe(false);
  });

  // ── Exit-code classification (Phase 4 fix, 2026-05-21) ──────────────
  // The old code used `text.includes('exited with code 1')`, which
  // matched "exited with code 143" because "1" is a prefix of "143".
  // Phase 4 switches to exact regex matching and adds service_terminated.

  it('classifies exit code 143 (SIGTERM) as service_terminated', () => {
    const err = new Error('Claude Code process exited with code 143');
    const classified = classifyError(err);
    expect(classified.category).toBe('service_terminated');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldNewChat).toBe(false);
    expect(classified.recovery.shouldSwitchModel).toBe(false);
    expect(classified.recovery.userMessage).toContain('restarted mid-task');
  });

  it('classifies exit code 137 (SIGKILL/OOM) as service_terminated', () => {
    const err = new Error('Claude Code process exited with code 137');
    const classified = classifyError(err);
    expect(classified.category).toBe('service_terminated');
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldNewChat).toBe(false);
  });

  it('classifies exit code 143 even when contextTokens is supplied (no false context_exhausted)', () => {
    // Regression guard for the bug Phase 4 fixes: with the old substring
    // match, exit 143 + non-zero contextTokens classified as context_exhausted.
    const err = new Error('Claude Code process exited with code 143');
    const classified = classifyError(err, 950000);
    expect(classified.category).toBe('service_terminated');
    expect(classified.recovery.shouldNewChat).toBe(false);
  });

  it('classifies exit code 1 as subprocess_crash regardless of contextTokens', () => {
    // Phase 4: context_exhausted is no longer inferred from exit codes.
    // Real context exhaustion comes from the Anthropic API error patterns below.
    expect(classifyError(new Error('Process exited with code 1')).category).toBe('subprocess_crash');
    expect(classifyError(new Error('Process exited with code 1'), 950000).category).toBe('subprocess_crash');
  });

  it('classifies other non-signal exit codes as subprocess_crash', () => {
    const err = new Error('Process exited with code 99');
    const classified = classifyError(err);
    expect(classified.category).toBe('subprocess_crash');
    expect(classified.recovery.shouldRetry).toBe(true);
  });

  // ── Anthropic API context-exhaustion patterns ───────────────────────

  it('classifies Anthropic 400 "prompt is too long" as context_exhausted', () => {
    const err = new Error('HTTP 400: prompt is too long: 250000 tokens > 200000 maximum');
    const classified = classifyError(err);
    expect(classified.category).toBe('context_exhausted');
    expect(classified.recovery.shouldNewChat).toBe(true);
  });

  it('classifies "context_length_exceeded" code as context_exhausted', () => {
    const err = new Error('Anthropic API error: context_length_exceeded');
    const classified = classifyError(err);
    expect(classified.category).toBe('context_exhausted');
    expect(classified.recovery.shouldNewChat).toBe(true);
  });

  // ── Unknown errors ──────────────────────────────────────────────────

  it('classifies unknown errors as unknown', () => {
    const err = new Error('something completely unexpected');
    const classified = classifyError(err);
    expect(classified.category).toBe('unknown');
    expect(classified.recovery.shouldRetry).toBe(false);
  });

  it('handles non-Error inputs', () => {
    const classified = classifyError('string error');
    expect(classified).toBeInstanceOf(AgentError);
    expect(classified.category).toBe('unknown');
  });

  it('handles null/undefined inputs', () => {
    const classified = classifyError(undefined);
    expect(classified).toBeInstanceOf(AgentError);
  });

  // ── Recovery properties ─────────────────────────────────────────────

  it('rate_limit has positive retryAfterMs', () => {
    const classified = classifyError(new Error('rate limit'));
    expect(classified.recovery.retryAfterMs).toBeGreaterThan(0);
  });

  it('auth never suggests retry', () => {
    const classified = classifyError(new Error('unauthorized'));
    expect(classified.recovery.shouldRetry).toBe(false);
    expect(classified.recovery.shouldSwitchModel).toBe(false);
  });

  it('billing suggests switching model', () => {
    const classified = classifyError(new Error('insufficient credits'));
    expect(classified.recovery.shouldSwitchModel).toBe(true);
  });

  it('userMessage never contains stack traces', () => {
    const err = new Error('rate limit exceeded');
    err.stack = 'Error: rate limit exceeded\n    at Object.<anonymous> (/foo/bar.js:1:1)';
    const classified = classifyError(err);
    expect(classified.recovery.userMessage).not.toContain('/foo/bar.js');
    expect(classified.recovery.userMessage).not.toContain('at Object');
  });

  it('userMessage is always populated', () => {
    const categories = [
      new Error('rate limit'),
      new Error('unauthorized'),
      new Error('insufficient credits'),
      new Error('overloaded'),
      new Error('ENOTFOUND'),
      new Error('timed out'),
      new Error('context length'),
      new Error('exited with code 1'),
      new Error('total mystery'),
    ];
    for (const err of categories) {
      const classified = classifyError(err);
      expect(classified.recovery.userMessage.length).toBeGreaterThan(0);
    }
  });

  // ── originalError preserved ─────────────────────────────────────────

  it('preserves the original error', () => {
    const original = new Error('rate limit exceeded');
    const classified = classifyError(original);
    expect(classified.originalError).toBe(original);
  });

  // ── Case insensitivity ──────────────────────────────────────────────

  it('matches patterns case-insensitively', () => {
    expect(classifyError(new Error('RATE LIMIT EXCEEDED')).category).toBe('rate_limit');
    expect(classifyError(new Error('Unauthorized')).category).toBe('auth');
    expect(classifyError(new Error('OVERLOADED')).category).toBe('overloaded');
  });
});
