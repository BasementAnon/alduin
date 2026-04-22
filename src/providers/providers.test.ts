import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMCompletionRequest } from '../types/llm.js';

// --- Mock @anthropic-ai/sdk ---
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  // Expose a static APIError class for error mapping tests
  class APIError extends Error {
    status: number;
    headers: Record<string, string>;
    constructor(message: string, status: number, headers: Record<string, string> = {}) {
      super(message);
      this.name = 'APIError';
      this.status = status;
      this.headers = headers;
    }
  }
  (MockAnthropic as unknown as Record<string, unknown>).APIError = APIError;
  (MockAnthropic as unknown as Record<string, unknown>).default = MockAnthropic;
  return { default: MockAnthropic, APIError };
});

// --- Mock openai SDK ---
vi.mock('openai', () => {
  const mockCreate = vi.fn();
  const MockOpenAI = vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  }));
  class APIError extends Error {
    status: number;
    headers: Record<string, string>;
    constructor(message: string, status: number, headers: Record<string, string> = {}) {
      super(message);
      this.name = 'APIError';
      this.status = status;
      this.headers = headers;
    }
  }
  (MockOpenAI as unknown as Record<string, unknown>).APIError = APIError;
  (MockOpenAI as unknown as Record<string, unknown>).default = MockOpenAI;
  return { default: MockOpenAI, APIError };
});

// Imports after mocks
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const baseRequest: LLMCompletionRequest = {
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 100,
};

// ──────────────────────────────────────────
// AnthropicProvider tests
// ──────────────────────────────────────────
describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new AnthropicProvider('test-key');
    // Access the mock through the Anthropic constructor mock
    const instance = vi.mocked(Anthropic).mock.results[0]?.value as {
      messages: { create: ReturnType<typeof vi.fn> };
    };
    mockCreate = instance.messages.create;
  });

  it('maps a successful completion response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello back!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    const result = await provider.complete(baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Hello back!');
      expect(result.value.usage.input_tokens).toBe(10);
      expect(result.value.usage.output_tokens).toBe(5);
      expect(result.value.finish_reason).toBe('stop');
    }
  });

  it('extracts system messages as separate param', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 5, output_tokens: 2 },
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
    });

    await provider.complete({
      ...baseRequest,
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const callArgs = mockCreate.mock.calls[0]?.[0] as {
      system?: string;
      messages: Array<{ role: string }>;
    };
    expect(callArgs.system).toBe('You are helpful.');
    expect(callArgs.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('maps 429 rate limit error with retryable flag', async () => {
    const apiError = new (Anthropic.APIError as unknown as new (
      msg: string,
      status: number,
      headers: Record<string, string>
    ) => Error & { status: number; headers: Record<string, string> })(
      'Rate limited',
      429,
      { 'retry-after': '30' }
    );
    mockCreate.mockRejectedValue(apiError);

    const result = await provider.complete(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('rate_limit');
      expect(result.error.retryable).toBe(true);
      expect(result.error.retry_after_ms).toBe(30000);
    }
  });

  it('maps 401 auth error', async () => {
    const apiError = new (Anthropic.APIError as unknown as new (
      msg: string,
      status: number
    ) => Error & { status: number })(
      'Unauthorized',
      401
    );
    mockCreate.mockRejectedValue(apiError);

    const result = await provider.complete(baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('auth');
      expect(result.error.retryable).toBe(false);
    }
  });
});

// ──────────────────────────────────────────
// OpenAIProvider tests
// ──────────────────────────────────────────
describe('OpenAIProvider', () => {
  let provider: OpenAIProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAIProvider('test-key');
    const instance = vi.mocked(OpenAI).mock.results[0]?.value as {
      chat: { completions: { create: ReturnType<typeof vi.fn> } };
    };
    mockCreate = instance.chat.completions.create;
  });

  it('maps a successful completion response', async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: { content: 'Hello from GPT!' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
      model: 'gpt-4.1',
    });

    const result = await provider.complete({
      ...baseRequest,
      model: 'openai/gpt-4.1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Hello from GPT!');
      expect(result.value.usage.input_tokens).toBe(8);
      expect(result.value.usage.output_tokens).toBe(4);
      expect(result.value.finish_reason).toBe('stop');
    }
  });

  it('maps 429 rate limit error', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (
      msg: string,
      status: number,
      headers: Record<string, string>
    ) => Error & { status: number; headers: Record<string, string> })(
      'Too Many Requests',
      429,
      { 'retry-after': '60' }
    );
    mockCreate.mockRejectedValue(apiError);

    const result = await provider.complete({
      ...baseRequest,
      model: 'openai/gpt-4.1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('rate_limit');
      expect(result.error.retryable).toBe(true);
      expect(result.error.retry_after_ms).toBe(60000);
    }
  });

  it('maps 401 auth error', async () => {
    const apiError = new (OpenAI.APIError as unknown as new (
      msg: string,
      status: number
    ) => Error & { status: number })(
      'Invalid API key',
      401
    );
    mockCreate.mockRejectedValue(apiError);

    const result = await provider.complete({
      ...baseRequest,
      model: 'openai/gpt-4.1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('auth');
    }
  });
});

// ──────────────────────────────────────────
// OllamaProvider tests
// ──────────────────────────────────────────
describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider('http://localhost:11434');
  });

  it('maps a successful Ollama response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'qwen2.5-7b',
        message: { role: 'assistant', content: 'Hello from Ollama!' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 4,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await provider.complete({
      ...baseRequest,
      model: 'ollama/qwen2.5-7b',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Hello from Ollama!');
      expect(result.value.usage.input_tokens).toBe(5);
      expect(result.value.usage.output_tokens).toBe(4);
    }
    vi.unstubAllGlobals();
  });

  it('returns provider_error when Ollama is not running (fetch TypeError)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const result = await provider.complete({
      ...baseRequest,
      model: 'ollama/qwen2.5-7b',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('provider_error');
      expect(result.error.message).toContain('Ollama not running');
      expect(result.error.retryable).toBe(false);
    }
    vi.unstubAllGlobals();
  });

  it('always returns 0 cost', () => {
    expect(
      provider.estimateCost('ollama/qwen2.5-7b', {
        input_tokens: 100000,
        output_tokens: 50000,
      })
    ).toBe(0);
  });
});

// ──────────────────────────────────────────
// OpenAICompatibleProvider tests
// ──────────────────────────────────────────
describe('OpenAICompatibleProvider', () => {
  it('has id openai-compatible', () => {
    vi.clearAllMocks();
    const provider = new OpenAICompatibleProvider(
      'https://api.deepseek.com/v1',
      'test-key'
    );
    expect(provider.id).toBe('openai-compatible');
  });

  it('maps a successful completion response via OpenAI SDK', async () => {
    vi.clearAllMocks();
    const provider = new OpenAICompatibleProvider(
      'https://api.deepseek.com/v1',
      'test-key'
    );

    // Get the mock instance created for this provider
    const instances = vi.mocked(OpenAI).mock.results;
    const lastInstance = instances[instances.length - 1]?.value as {
      chat: { completions: { create: ReturnType<typeof vi.fn> } };
    };
    lastInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'DeepSeek response' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 6, completion_tokens: 3 },
      model: 'deepseek-v3',
    });

    const result = await provider.complete({
      ...baseRequest,
      model: 'deepseek/deepseek-v3.2',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('DeepSeek response');
    }
  });
});
