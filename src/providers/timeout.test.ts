/**
 * Tests that SDK clients are constructed with the configured timeout and that
 * timeout errors are mapped to LLMError type='timeout'.
 *
 * We cannot use a real blocking HTTP server in unit tests, so we:
 * 1. Assert the SDK constructor receives the correct `timeout` option.
 * 2. Simulate a timeout error (APIConnectionTimeoutError / AbortError) and
 *    assert the provider maps it to { type: 'timeout', retryable: true }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMCompletionRequest } from '../types/llm.js';

// ── Mock SDKs (capture constructor args) ─────────────────────────────────────

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  class APIError extends Error {
    status: number; headers: Record<string, string>;
    constructor(message: string, status: number, headers: Record<string, string> = {}) {
      super(message); this.name = 'APIError'; this.status = status; this.headers = headers;
    }
  }
  (MockAnthropic as unknown as Record<string, unknown>).APIError = APIError;
  (MockAnthropic as unknown as Record<string, unknown>).default = MockAnthropic;
  return { default: MockAnthropic, APIError };
});

vi.mock('openai', () => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  class APIError extends Error {
    status: number; headers: Record<string, string>;
    constructor(message: string, status: number, headers: Record<string, string> = {}) {
      super(message); this.name = 'APIError'; this.status = status; this.headers = headers;
    }
  }
  (MockOpenAI as unknown as Record<string, unknown>).APIError = APIError;
  (MockOpenAI as unknown as Record<string, unknown>).default = MockOpenAI;
  return { default: MockOpenAI, APIError };
});

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const baseRequest: LLMCompletionRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 100,
};

// ── Constructor timeout forwarding ────────────────────────────────────────────

describe('Provider timeout — SDK constructor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AnthropicProvider passes default 60s timeout when none configured', () => {
    new AnthropicProvider('key');
    const ctorArgs = vi.mocked(Anthropic).mock.calls[0]?.[0] as { timeout?: number };
    expect(ctorArgs.timeout).toBe(60_000);
  });

  it('AnthropicProvider passes custom timeout to SDK constructor', () => {
    new AnthropicProvider('key', undefined, 5_000);
    const ctorArgs = vi.mocked(Anthropic).mock.calls[0]?.[0] as { timeout?: number };
    expect(ctorArgs.timeout).toBe(5_000);
  });

  it('OpenAIProvider passes default 60s timeout when none configured', () => {
    new OpenAIProvider('key');
    const ctorArgs = vi.mocked(OpenAI).mock.calls[0]?.[0] as { timeout?: number };
    expect(ctorArgs.timeout).toBe(60_000);
  });

  it('OpenAIProvider passes custom timeout to SDK constructor', () => {
    new OpenAIProvider('key', undefined, 10_000);
    const ctorArgs = vi.mocked(OpenAI).mock.calls[0]?.[0] as { timeout?: number };
    expect(ctorArgs.timeout).toBe(10_000);
  });

  it('OpenAICompatibleProvider forwards timeout and baseURL', () => {
    new OpenAICompatibleProvider('https://api.deepseek.com/v1', 'key', undefined, 15_000);
    const calls = vi.mocked(OpenAI).mock.calls;
    // super() calls once; constructor replaces client once more
    const lastCtorArgs = calls[calls.length - 1]?.[0] as { timeout?: number; baseURL?: string };
    expect(lastCtorArgs.timeout).toBe(15_000);
    expect(lastCtorArgs.baseURL).toBe('https://api.deepseek.com/v1');
  });
});

// ── Timeout error mapping ─────────────────────────────────────────────────────

describe('Provider timeout — error mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AnthropicProvider maps AbortError to LLMError type=timeout', async () => {
    const provider = new AnthropicProvider('key', undefined, 200);
    const instance = vi.mocked(Anthropic).mock.results[0]?.value as {
      messages: { create: ReturnType<typeof vi.fn> };
    };

    const abortErr = new Error('Request timed out');
    abortErr.name = 'AbortError';
    instance.messages.create.mockRejectedValue(abortErr);

    const result = await provider.complete(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('timeout');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('OpenAIProvider maps AbortError to LLMError type=timeout', async () => {
    const provider = new OpenAIProvider('key', undefined, 200);
    const instance = vi.mocked(OpenAI).mock.results[0]?.value as {
      chat: { completions: { create: ReturnType<typeof vi.fn> } };
    };

    const abortErr = new Error('Connection timed out');
    abortErr.name = 'AbortError';
    instance.chat.completions.create.mockRejectedValue(abortErr);

    const result = await provider.complete({ ...baseRequest, model: 'gpt-4.1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('timeout');
      expect(result.error.retryable).toBe(true);
    }
  });

  it('OpenAICompatibleProvider inherits timeout error mapping', async () => {
    const provider = new OpenAICompatibleProvider(
      'https://api.deepseek.com/v1', 'key', undefined, 200
    );
    const instances = vi.mocked(OpenAI).mock.results;
    const lastInstance = instances[instances.length - 1]?.value as {
      chat: { completions: { create: ReturnType<typeof vi.fn> } };
    };

    const abortErr = new Error('Timed out');
    abortErr.name = 'AbortError';
    lastInstance.chat.completions.create.mockRejectedValue(abortErr);

    const result = await provider.complete({ ...baseRequest, model: 'deepseek-v3.2' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('timeout');
      expect(result.error.retryable).toBe(true);
    }
  });
});
