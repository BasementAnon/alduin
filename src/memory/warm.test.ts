import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WarmMemory } from './warm.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TokenCounter } from '../tokens/counter.js';
import type { LLMProvider } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';
import type { ConversationTurn } from '../types/llm.js';

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return { id, complete: vi.fn(), countTokens: () => 0, estimateCost: () => 0 };
}

function turn(role: 'user' | 'assistant', content: string): ConversationTurn {
  return { role, content, timestamp: new Date() };
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
  },
  providers: { ollama: { base_url: 'http://localhost:11434' } },
  routing: { pre_classifier: true, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
  memory: { hot_turns: 3, warm_max_tokens: 500, cold_enabled: false },
};

describe('WarmMemory', () => {
  let registry: ProviderRegistry;
  let provider: ReturnType<typeof mockProvider>;
  let warm: WarmMemory;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ProviderRegistry();
    provider = mockProvider('ollama');
    registry.register('ollama', provider);
    warm = new WarmMemory(registry, testConfig, new TokenCounter());
  });

  it('sets initial summary on the first turn without an LLM call', async () => {
    await warm.absorbTurn(turn('user', 'Hello, my name is Alice.'));

    expect(warm.getSummary()).toContain('user: Hello, my name is Alice.');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(warm.getTokenCount()).toBeGreaterThan(0);
  });

  it('calls the cheap model to update summary on subsequent turns', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'User introduced themselves as Alice. She prefers TypeScript.',
        usage: { input_tokens: 80, output_tokens: 15 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    await warm.absorbTurn(turn('user', 'First turn')); // no LLM
    await warm.absorbTurn(turn('assistant', 'She prefers TypeScript.')); // triggers LLM

    expect(provider.complete).toHaveBeenCalledOnce();
    expect(warm.getSummary()).toBe(
      'User introduced themselves as Alice. She prefers TypeScript.'
    );
  });

  it('falls back to append+truncate when the LLM call fails', async () => {
    provider.complete.mockResolvedValue({
      ok: false,
      error: { type: 'provider_error' as const, message: 'Down', retryable: false },
    });

    await warm.absorbTurn(turn('user', 'First turn'));
    const summaryBefore = warm.getSummary();
    await warm.absorbTurn(turn('assistant', 'Second turn'));

    const summaryAfter = warm.getSummary();
    // Summary should contain both pieces of info
    expect(summaryAfter).toContain('First turn');
    expect(summaryAfter).toContain('Second turn');
    // Fallback appended — different from before
    expect(summaryAfter).not.toBe(summaryBefore);
  });

  it('clear resets summary and token count', async () => {
    await warm.absorbTurn(turn('user', 'Some content'));
    warm.clear();
    expect(warm.getSummary()).toBe('');
    expect(warm.getTokenCount()).toBe(0);
  });

  it('getSummary returns the current summary string', async () => {
    expect(warm.getSummary()).toBe('');
    await warm.absorbTurn(turn('user', 'Test content'));
    expect(warm.getSummary()).not.toBe('');
  });

  // ── Redaction tests ──────────────────────────────────────────────────────────

  it('redacts Anthropic key echoed by the summarizer in the LLM update path', async () => {
    // The summarizer model echoes back a credential the user pasted
    const echoedKey = 'sk-ant-aaaabbbbccccddddeeeeffffgggg';
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: `User's API key is ${echoedKey}. Task: summarize document.`,
        usage: { input_tokens: 80, output_tokens: 20 },
        model: 'qwen2.5-7b',
        finish_reason: 'stop',
      },
    });

    await warm.absorbTurn(turn('user', 'First turn'));        // no LLM
    await warm.absorbTurn(turn('assistant', 'Second turn'));  // triggers LLM

    const summary = warm.getSummary();
    expect(summary).not.toContain(echoedKey);
    expect(summary).toContain('[REDACTED_ANTHROPIC]');
  });

  it('redacts OpenAI key echoed in the first-turn (inline) path', async () => {
    const openaiKey = 'sk-abcdefghijklmnopqrstuvwxyz12345';
    await warm.absorbTurn(turn('user', `My key is ${openaiKey}`));

    const summary = warm.getSummary();
    expect(summary).not.toContain(openaiKey);
    expect(summary).toContain('[REDACTED_OPENAI]');
  });

  it('redacts a credential injected via the fallback append+truncate path', async () => {
    provider.complete.mockResolvedValue({
      ok: false,
      error: { type: 'provider_error' as const, message: 'Down', retryable: false },
    });

    const ghToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    await warm.absorbTurn(turn('user', 'First turn'));
    await warm.absorbTurn(turn('assistant', `Token: ${ghToken}`));

    const summary = warm.getSummary();
    expect(summary).not.toContain(ghToken);
    expect(summary).toContain('[REDACTED_GITHUB]');
  });

  it('redactSecrets is idempotent — applying it twice yields the same result', async () => {
    const { redactSecrets } = await import('./redactor.js');

    const raw = 'key: sk-ant-aaaabbbbccccddddeeeeffffgggg and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const once = redactSecrets(raw);
    const twice = redactSecrets(once);
    expect(once).toBe(twice);
    expect(once).not.toContain('sk-ant-');
    expect(once).not.toContain('ghp_');
  });
});
