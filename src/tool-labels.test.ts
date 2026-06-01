import { describe, it, expect } from 'vitest';
import { toolLabel } from './tool-labels.js';

describe('toolLabel', () => {
  it('maps known built-in tools to human labels', () => {
    expect(toolLabel('Read')).toBe('Reading file');
    expect(toolLabel('Write')).toBe('Writing file');
    expect(toolLabel('Edit')).toBe('Editing file');
    expect(toolLabel('Bash')).toBe('Running command');
    expect(toolLabel('Grep')).toBe('Searching code');
    expect(toolLabel('Glob')).toBe('Finding files');
    expect(toolLabel('WebSearch')).toBe('Web search');
    expect(toolLabel('WebFetch')).toBe('Fetching page');
    expect(toolLabel('Agent')).toBe('Sub-agent');
    expect(toolLabel('NotebookEdit')).toBe('Editing notebook');
    expect(toolLabel('AskUserQuestion')).toBe('User question');
  });

  it('formats an MCP tool as "server: tool"', () => {
    expect(toolLabel('mcp__gmail__send_email')).toBe('gmail: send_email');
  });

  it('joins the remaining segments when an MCP tool name itself has __', () => {
    expect(toolLabel('mcp__github__create__pr')).toBe('github: create pr');
  });

  it('falls back to the raw name for a malformed mcp__ name with too few parts', () => {
    expect(toolLabel('mcp__server')).toBe('mcp__server');
  });

  it('returns an unknown tool name unchanged', () => {
    expect(toolLabel('SomeFutureTool')).toBe('SomeFutureTool');
  });

  it('returns the empty string unchanged', () => {
    expect(toolLabel('')).toBe('');
  });
});
