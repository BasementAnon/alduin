import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResultSummarizer } from './summarizer.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider } from '../types/llm.js';

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    complete: vi.fn(),
    countTokens: () => 0,
    estimateCost: () => 0,
  };
}

describe('ResultSummarizer', () => {
  let registry: ProviderRegistry;
  let provider: ReturnType<typeof mockProvider>;
  let summarizer: ResultSummarizer;

  beforeEach(() => {
    registry = new ProviderRegistry();
    provider = mockProvider('ollama');
    registry.register('ollama', provider);
    summarizer = new ResultSummarizer(registry, {
      model: 'ollama/qwen2.5-7b',
      max_tokens: 300,
    });
  });

  it('returns short output as-is without making an LLM call', async () => {
    const shortOutput = 'Task completed successfully.';
    const result = await summarizer.summarize('code', shortOutput, 300);

    expect(result).toBe(shortOutput);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('calls the cheap model to summarize long output', async () => {
    const longOutput = 'A '.repeat(2000); // way over 300 tokens

    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'Generated summary of the code output.',
        usage: { input_tokens: 500, output_tokens: 20 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop' as const,
      },
    });

    const result = await summarizer.summarize('code', longOutput, 300);

    expect(result).toBe('Generated summary of the code output.');
    expect(provider.complete).toHaveBeenCalledTimes(1);

    // Verify the prompt includes key instructions
    const callArgs = provider.complete.mock.calls[0]?.[0] as {
      messages: Array<{ content: string }>;
    };
    expect(callArgs.messages[0].content).toContain('Summarize');
    expect(callArgs.messages[0].content).toContain('300 tokens');
  });

  it('falls back to truncation when the LLM call fails', async () => {
    const longOutput = 'word '.repeat(2000);

    provider.complete.mockResolvedValue({
      ok: false,
      error: {
        type: 'provider_error',
        message: 'Service unavailable',
        retryable: false,
      },
    });

    const result = await summarizer.summarize('research', longOutput, 300);

    // Should be truncated, not the full output
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('...');
  });

  it('falls back to truncation when no provider is registered', async () => {
    const emptyRegistry = new ProviderRegistry();
    const noProviderSummarizer = new ResultSummarizer(emptyRegistry, {
      model: 'unknown/model',
      max_tokens: 300,
    });

    const longOutput = 'data '.repeat(2000);
    const result = await noProviderSummarizer.summarize('code', longOutput, 300);

    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('...');
  });
});
