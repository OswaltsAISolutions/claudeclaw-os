import { describe, it, expect } from 'vitest';
import { parseDelegation } from './orchestrator.js';

// parseDelegation is the front door for inter-agent delegation. The
// registry is empty here (initOrchestrator is never called), which is
// exactly the state that exercises the "don't false-positive on @mentions
// of unknown agents" guard.
describe('parseDelegation', () => {
  describe('/delegate command form', () => {
    it('parses "/delegate <id> <prompt>"', () => {
      expect(parseDelegation('/delegate ops do the thing')).toEqual({
        agentId: 'ops',
        prompt: 'do the thing',
      });
    });

    it('is case-insensitive on the command word', () => {
      expect(parseDelegation('/DELEGATE ops hi')).toEqual({
        agentId: 'ops',
        prompt: 'hi',
      });
    });

    it('collapses the gap after the id and trims the prompt', () => {
      expect(parseDelegation('/delegate ops    spaced   prompt   ')).toEqual({
        agentId: 'ops',
        prompt: 'spaced   prompt',
      });
    });

    it('keeps a multi-line prompt intact', () => {
      expect(parseDelegation('/delegate ops line1\nline2')).toEqual({
        agentId: 'ops',
        prompt: 'line1\nline2',
      });
    });

    it('returns null when the command has an id but no prompt', () => {
      expect(parseDelegation('/delegate ops')).toBeNull();
    });
  });

  describe('@id: colon form', () => {
    it('parses "@<id>: <prompt>"', () => {
      expect(parseDelegation('@ops: schedule a meeting')).toEqual({
        agentId: 'ops',
        prompt: 'schedule a meeting',
      });
    });

    it('does not require a space after the colon', () => {
      expect(parseDelegation('@ops:do thing')).toEqual({
        agentId: 'ops',
        prompt: 'do thing',
      });
    });

    it('trims extra whitespace after the colon', () => {
      expect(parseDelegation('@ops:    padded')).toEqual({
        agentId: 'ops',
        prompt: 'padded',
      });
    });

    it('allows hyphenated agent ids', () => {
      expect(parseDelegation('@my-agent: go')).toEqual({
        agentId: 'my-agent',
        prompt: 'go',
      });
    });

    it('captures the id lazily, stopping at the first colon', () => {
      expect(parseDelegation('@ops: a:b:c')).toEqual({
        agentId: 'ops',
        prompt: 'a:b:c',
      });
    });

    it('returns null for a colon with no prompt after it', () => {
      expect(parseDelegation('@ops:')).toBeNull();
    });
  });

  describe('no-colon @mention and non-delegations', () => {
    it('does not delegate to an unknown agent mentioned without a colon', () => {
      // Empty registry => no false positive; this is just a chat message.
      expect(parseDelegation('@ops something')).toBeNull();
    });

    it('returns null for plain text', () => {
      expect(parseDelegation('hello world')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseDelegation('')).toBeNull();
    });
  });
});
