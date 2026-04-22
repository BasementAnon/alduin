import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageClassifier } from './classifier.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TokenCounter } from '../tokens/counter.js';
import type { LLMProvider } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    complete: vi.fn(),
    countTokens: () => 0,
    estimateCost: () => 0,
  };
}

const testConfig: AlduinConfig = {
  orchestrator: {
    model: 'anthropic/claude-sonnet-4-6',
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  },
  executors: {
    classifier: {
      model: 'ollama/qwen2.5-7b',
      max_tokens: 200,
      tools: [],
      context: 'message_only',
    },
    code: {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 8000,
      tools: ['file_read', 'file_write'],
      context: 'task_only',
    },
    research: {
      model: 'openai/gpt-4.1',
      max_tokens: 4000,
      tools: ['web_search'],
      context: 'task_only',
    },
    quick: {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 2000,
      tools: ['calendar'],
      context: 'task_only',
    },
  },
  providers: {
    anthropic: { api_key_env: 'ANTHROPIC_API_KEY' },
    openai: { api_key_env: 'OPENAI_API_KEY' },
    ollama: { base_url: 'http://localhost:11434' },
  },
  routing: {
    pre_classifier: true,
    classifier_model: 'classifier',
    complexity_threshold: 0.6,
  },
  budgets: {
    daily_limit_usd: 10.0,
    per_task_limit_usd: 2.0,
    warning_threshold: 0.8,
  },
};

describe('MessageClassifier', () => {
  let registry: ProviderRegistry;
  let provider: ReturnType<typeof mockProvider>;
  let classifier: MessageClassifier;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ProviderRegistry();
    provider = mockProvider('ollama');
    registry.register('ollama', provider);
    classifier = new MessageClassifier(registry, testConfig, new TokenCounter());
  });

  it('classifies a conversational message correctly', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          complexity: 'low',
          category: 'conversation',
          suggested_executor: null,
          needs_orchestrator: false,
          confidence: 0.95,
          reasoning: 'Simple greeting',
        }),
        usage: { input_tokens: 50, output_tokens: 20 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    const result = await classifier.classify('Hey, how are you?');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.category).toBe('conversation');
      expect(result.value.needs_orchestrator).toBe(false);
      expect(result.value.suggested_executor).toBeNull();
      expect(result.value.confidence).toBe(0.95);
    }
  });

  it('routes code request to code executor', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          complexity: 'medium',
          category: 'code',
          suggested_executor: 'code',
          needs_orchestrator: false,
          confidence: 0.9,
          reasoning: 'Single code task',
        }),
        usage: { input_tokens: 50, output_tokens: 20 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    const result = await classifier.classify('Write a Python quicksort function');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.category).toBe('code');
      expect(result.value.suggested_executor).toBe('code');
      expect(result.value.needs_orchestrator).toBe(false);
    }
  });

  it('flags multi-step request as needs_orchestrator', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          complexity: 'high',
          category: 'multi_step',
          suggested_executor: null,
          needs_orchestrator: true,
          confidence: 0.9,
          reasoning: 'Research then content creation requires orchestration',
        }),
        usage: { input_tokens: 60, output_tokens: 25 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    const result = await classifier.classify(
      'Research competitors in the CRM space and build me a comparison spreadsheet'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.needs_orchestrator).toBe(true);
      expect(result.value.suggested_executor).toBeNull();
      expect(result.value.category).toBe('multi_step');
    }
  });

  it('falls back to default classification on JSON parse failure', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'This is not valid JSON at all!',
        usage: { input_tokens: 50, output_tokens: 10 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    const result = await classifier.classify('Do something');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.needs_orchestrator).toBe(true);
      expect(result.value.confidence).toBe(0.0);
    }
  });

  it('falls back to default classification when provider call fails', async () => {
    provider.complete.mockResolvedValue({
      ok: false,
      error: {
        type: 'provider_error' as const,
        message: 'Connection refused',
        retryable: false,
      },
    });

    const result = await classifier.classify('Do something');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.needs_orchestrator).toBe(true);
      expect(result.value.confidence).toBe(0.0);
    }
  });

  it('falls back to default when no provider is registered for classifier model', async () => {
    const emptyRegistry = new ProviderRegistry();
    const noProviderClassifier = new MessageClassifier(
      emptyRegistry,
      testConfig,
      new TokenCounter()
    );

    const result = await noProviderClassifier.classify('Hello');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.needs_orchestrator).toBe(true);
      expect(result.value.confidence).toBe(0.0);
      expect(result.value.reasoning).toContain('unavailable');
    }
  });

  it('rejects an invalid suggested_executor not in config', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          complexity: 'medium',
          category: 'code',
          suggested_executor: 'nonexistent_executor',
          needs_orchestrator: false,
          confidence: 0.9,
          reasoning: 'Single code task',
        }),
        usage: { input_tokens: 50, output_tokens: 20 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    const result = await classifier.classify('Fix my bug');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Invalid executor should be rejected — fall back to null
      expect(result.value.suggested_executor).toBeNull();
    }
  });

  it('sends only the user message in the LLM request (no history)', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: JSON.stringify({
          complexity: 'low',
          category: 'conversation',
          suggested_executor: null,
          needs_orchestrator: false,
          confidence: 0.9,
          reasoning: 'Greeting',
        }),
        usage: { input_tokens: 30, output_tokens: 15 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    await classifier.classify('Hello!');

    const callArgs = provider.complete.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
      max_tokens: number;
    };

    // Only system + the raw user message — no history injected
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0]?.role).toBe('system');
    expect(callArgs.messages[1]?.role).toBe('user');
    expect(callArgs.messages[1]?.content).toBe('Hello!');
    expect(callArgs.max_tokens).toBe(200);
  });
});
