import { describe, it, expect } from 'vitest';
import { buildOllamaUrlFromHost } from './ollama.js';

// buildOllamaUrlFromHost is the pure core of OLLAMA_HOST resolution. Every
// local specialist reaches Ollama through the URL this produces, so the
// scheme / port / trailing-slash rules are worth pinning.
describe('buildOllamaUrlFromHost', () => {
  it('returns a full http/https URL verbatim', () => {
    expect(buildOllamaUrlFromHost('http://1.2.3.4:11434', '11434')).toBe('http://1.2.3.4:11434');
    expect(buildOllamaUrlFromHost('https://remote.example', '11434')).toBe('https://remote.example');
  });

  it('strips exactly one trailing slash from a full URL', () => {
    expect(buildOllamaUrlFromHost('http://host:1234/', '11434')).toBe('http://host:1234');
    // Only one slash is removed by design.
    expect(buildOllamaUrlFromHost('http://host//', '11434')).toBe('http://host/');
  });

  it('keeps an explicit host:port and just adds the http scheme', () => {
    expect(buildOllamaUrlFromHost('192.168.1.5:9999', '11434')).toBe('http://192.168.1.5:9999');
  });

  it('appends the fallback port to a bare host', () => {
    expect(buildOllamaUrlFromHost('192.168.1.5', '11434')).toBe('http://192.168.1.5:11434');
    expect(buildOllamaUrlFromHost('myhost', '8080')).toBe('http://myhost:8080');
  });
});
