import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { discoverOllama, discoverOpenAICompatible } from './discovery.js';

describe('Provider discovery', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('discoverOllama()', () => {
    it('parses /api/tags response into discovered models', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          models: [
            {
              name: 'llama3.2:7b',
              modified_at: '2025-01-15T10:00:00Z',
              details: { parameter_size: '7B' },
            },
            {
              name: 'codellama:13b',
              modified_at: '2025-02-01T12:00:00Z',
              details: { parameter_size: '13B' },
            },
          ],
        }),
      } as Response);

      const result = await discoverOllama('http://localhost:11434');

      expect(result.error).toBeUndefined();
      expect(result.provider).toBe('ollama');
      expect(result.models).toHaveLength(2);

      expect(result.models[0].id).toBe('ollama/llama3.2:7b');
      expect(result.models[0].entry.provider).toBe('ollama');
      expect(result.models[0].entry.pricing_usd_per_mtok.input).toBe(0);
      expect(result.models[0].source).toBe('discovered');
      expect(result.models[0].discovered_at).toBeTruthy();

      expect(result.models[1].id).toBe('ollama/codellama:13b');
      expect(result.models[1].entry.context_window).toBe(16384); // 13B estimate
    });

    it('handles 404 gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const result = await discoverOllama('http://localhost:11434');

      expect(result.models).toHaveLength(0);
      expect(result.error).toContain('404');
    });

    it('handles connection refused gracefully', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(
        new TypeError('fetch failed: ECONNREFUSED'),
      );

      const result = await discoverOllama('http://localhost:11434');

      expect(result.models).toHaveLength(0);
      expect(result.error).toContain('not running');
    });

    it('handles empty models list', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      } as Response);

      const result = await discoverOllama();

      expect(result.models).toHaveLength(0);
      expect(result.error).toBeUndefined();
    });
  });

  describe('discoverOpenAICompatible()', () => {
    it('parses /v1/models response into discovered models', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { id: 'deepseek-v3', created: 1700000000, owned_by: 'deepseek' },
            { id: 'deepseek-coder-v2', created: 1700100000, owned_by: 'deepseek' },
          ],
        }),
      } as Response);

      const result = await discoverOpenAICompatible('https://api.deepseek.com/v1', 'test-key');

      expect(result.error).toBeUndefined();
      expect(result.provider).toBe('deepseek');
      expect(result.models).toHaveLength(2);
      expect(result.models[0].id).toBe('deepseek/deepseek-v3');
      expect(result.models[0].source).toBe('discovered');
      expect(result.models[1].id).toBe('deepseek/deepseek-coder-v2');
    });

    it('sends Authorization header with API key', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      await discoverOpenAICompatible('https://api.example.com', 'sk-test-123');

      const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = fetchCall[1]?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer sk-test-123');
    });

    it('handles 404 gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      const result = await discoverOpenAICompatible('https://api.example.com', '');

      expect(result.models).toHaveLength(0);
      expect(result.error).toContain('404');
    });

    it('extracts provider name from URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'model-1' }] }),
      } as Response);

      const result = await discoverOpenAICompatible('https://api.together.xyz/v1', '');
      expect(result.provider).toBe('together');
    });

    it('uses openai-compatible for localhost URLs', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      const result = await discoverOpenAICompatible('http://localhost:8080', '');
      expect(result.provider).toBe('openai-compatible');
    });

    it('discovered models are tagged source: "discovered"', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'test-model', created: 1700000000 }],
        }),
      } as Response);

      const result = await discoverOpenAICompatible('https://api.deepseek.com', 'key');

      expect(result.models[0].source).toBe('discovered');
      expect(result.models[0].discovered_at).toBeTruthy();
    });
  });
});
