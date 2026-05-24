/**
 * Structured error taxonomy for ClaudeClaw agent failures.
 *
 * Classifies errors from the Claude Code SDK into actionable categories
 * with recovery hints, so the user gets helpful messages instead of
 * "Something went wrong."
 */

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'context_exhausted'
  | 'service_terminated'
  | 'timeout'
  | 'subprocess_crash'
  | 'network'
  | 'billing'
  | 'overloaded'
  | 'unknown';

export interface ErrorRecovery {
  shouldRetry: boolean;
  shouldNewChat: boolean;
  shouldSwitchModel: boolean;
  retryAfterMs: number;
  userMessage: string;
}

export class AgentError extends Error {
  category: ErrorCategory;
  recovery: ErrorRecovery;
  originalError: Error | undefined;

  constructor(category: ErrorCategory, recovery: ErrorRecovery, originalError?: Error) {
    super(recovery.userMessage);
    this.name = 'AgentError';
    this.category = category;
    this.recovery = recovery;
    this.originalError = originalError;
  }
}

// ── Pattern matchers ────────────────────────────────────────────────

const AUTH_PATTERNS = [
  'authentication',
  'unauthorized',
  'invalid api key',
  'invalid x-api-key',
  'api key not found',
  'not authenticated',
  'permission denied',
  'oauth',
  'token expired',
  'invalid_grant',
  'login required',
];

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'throttled',
  'requests per minute',
  '429',
];

const BILLING_PATTERNS = [
  'insufficient credits',
  'credits exhausted',
  'payment required',
  'billing',
  'quota exceeded',
  'usage limit',
  '402',
];

const OVERLOADED_PATTERNS = [
  'overloaded',
  'service unavailable',
  'capacity',
  '529',
  '503',
];

const NETWORK_PATTERNS = [
  'enotfound',
  'econnrefused',
  'econnreset',
  'etimedout',
  'socket hang up',
  'network',
  'dns',
  'fetch failed',
  'certificate',
];

const TIMEOUT_PATTERNS = [
  'timed out',
  'timeout',
  'deadline exceeded',
];

const CONTEXT_PATTERNS = [
  'context length',
  'context window',
  'max_tokens',
  'maximum tokens',
  'max input tokens',
  'too long',
  'token limit',
  'context_length_exceeded',
  'prompt is too long',
];

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

// ── Classification ──────────────────────────────────────────────────

/**
 * Classify a raw error from the Claude Code SDK into a structured AgentError.
 * Parses the error message and any stderr output for known patterns.
 * If the error is already an AgentError, returns it unchanged.
 */
export function classifyError(err: unknown, contextTokens?: number): AgentError {
  // Pass through already-classified errors
  if (err instanceof AgentError) return err;

  const raw = err instanceof Error ? err : new Error(String(err));
  const text = raw.message;

  // ── Exit-code dispatch ─────────────────────────────────────────────
  // Parse the exact exit code (regex, not substring — `exited with code 143`
  // must NOT match an `exited with code 1` rule).
  //
  // Phase 4 (2026-05-21): exit 143 (SIGTERM) and 137 (SIGKILL/OOM) mean the
  // process was terminated externally — usually a systemd restart. Surfacing
  // this as "context exhausted" (the old behavior) sent users down a useless
  // /newchat workaround. Real context exhaustion now matches on the Anthropic
  // API error patterns below, not on process exit codes.
  const exitMatch = text.match(/exited with code (\d+)/);
  if (exitMatch) {
    const exitCode = parseInt(exitMatch[1], 10);

    if (exitCode === 143 || exitCode === 137) {
      return new AgentError('service_terminated', {
        shouldRetry: false,
        shouldNewChat: false,
        shouldSwitchModel: false,
        retryAfterMs: 0,
        userMessage: "I was restarted mid-task and lost what I was working on. Resend the request and I'll start fresh.",
      }, raw);
    }

    // Exit 1 (or other non-zero, non-signal codes) = generic subprocess crash.
    // Retry is safe because the agent is stateless from the OS's POV — Claude
    // Code will pick up the same session on the next attempt.
    return new AgentError('subprocess_crash', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 2000,
      userMessage: 'Claude Code subprocess exited unexpectedly. Retrying...',
    }, raw);
  }

  if (matchesAny(text, AUTH_PATTERNS)) {
    return new AgentError('auth', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Authentication failed. Run `claude login` in your terminal to re-authenticate.',
    }, raw);
  }

  if (matchesAny(text, BILLING_PATTERNS)) {
    return new AgentError('billing', {
      shouldRetry: false,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 0,
      userMessage: 'API credits exhausted or billing issue. Check your Anthropic account, or try a different model.',
    }, raw);
  }

  if (matchesAny(text, RATE_LIMIT_PATTERNS)) {
    return new AgentError('rate_limit', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 30000,
      userMessage: 'Rate limited. Retrying in 30s...',
    }, raw);
  }

  if (matchesAny(text, OVERLOADED_PATTERNS)) {
    return new AgentError('overloaded', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: true,
      retryAfterMs: 5000,
      userMessage: 'Model is overloaded. Retrying...',
    }, raw);
  }

  if (matchesAny(text, NETWORK_PATTERNS)) {
    return new AgentError('network', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 3000,
      userMessage: 'Network error. Check your connection. Retrying...',
    }, raw);
  }

  if (matchesAny(text, TIMEOUT_PATTERNS)) {
    return new AgentError('timeout', {
      shouldRetry: true,
      shouldNewChat: false,
      shouldSwitchModel: false,
      retryAfterMs: 2000,
      userMessage: 'Request timed out. Retrying...',
    }, raw);
  }

  if (matchesAny(text, CONTEXT_PATTERNS)) {
    return new AgentError('context_exhausted', {
      shouldRetry: false,
      shouldNewChat: true,
      shouldSwitchModel: false,
      retryAfterMs: 0,
      userMessage: 'Context window limit reached. Use /newchat to start fresh.',
    }, raw);
  }

  return new AgentError('unknown', {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: 'Something went wrong. Check the logs and try again.',
  }, raw);
}
