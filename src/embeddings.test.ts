import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Ollama client at the module boundary so we exercise embedText's
// own retry/fallback logic without touching a real model server.
vi.mock('./ollama.js', () => ({
  ollamaEmbed: vi.fn(),
}));

import { cosineSimilarity, embedText } from './embeddings.js';
import { ollamaEmbed } from './ollama.js';

const mockEmbed = vi.mocked(ollamaEmbed);

describe('cosineSimilarity', () => {
  it('is 1 for identical direction vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('is 0 (no signal) for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
  });

  it('is 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('is 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe('embedText', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
  });

  it('returns [] for empty/whitespace input without calling the model', async () => {
    expect(await embedText('')).toEqual([]);
    expect(await embedText('   ')).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('returns the model vector on success', async () => {
    mockEmbed.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    expect(await embedText('hello world')).toEqual([0.1, 0.2, 0.3]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('retries with sanitized input on the known bge-m3 NaN error', async () => {
    mockEmbed
      .mockRejectedValueOnce(new Error('unsupported value: NaN'))
      .mockResolvedValueOnce([1, 2]);

    const result = await embedText('claw-runner.ts');
    expect(result).toEqual([1, 2]);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    // The retry feeds punctuation-stripped, whitespace-collapsed text.
    expect(mockEmbed.mock.calls[1][1]).toBe('claw runner ts');
  });

  it('does not retry on an unrelated error', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('connection refused'));
    expect(await embedText('hello world')).toEqual([]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the sanitized retry also fails', async () => {
    mockEmbed
      .mockRejectedValueOnce(new Error('NaN'))
      .mockRejectedValueOnce(new Error('NaN again'));
    expect(await embedText('foo-bar.py')).toEqual([]);
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it('does not retry when sanitizing would not change the input', async () => {
    // Plain text has nothing to strip, so a retry would just repeat the
    // identical failing call — skip it.
    mockEmbed.mockRejectedValueOnce(new Error('NaN'));
    expect(await embedText('hello')).toEqual([]);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });
});
