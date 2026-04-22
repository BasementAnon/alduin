import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorDispatcher } from './dispatch.js';
import { ProviderRegistry } from '../providers/registry.js';
import { BudgetTracker, BudgetGuard } from '../tokens/budget.js';
import { TokenCounter } from '../tokens/counter.js';
import { ResultSummarizer } from './summarizer.js';
import type { LLMProvider } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';
import type { ExecutorTask } from './types.js';

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    complete: vi.fn(),
    countTokens: () => 0,
    estimateCost: () => 0.01,
  };
}

function makeTask(overrides: Partial<ExecutorTask> = {}): ExecutorTask {
  return {
    id: 'task-1',
    executor_name: 'code',
    instruction: 'Write a hello world function.',
    max_tokens: 2000,
    timeout_ms: 5000,
    tools: [],
    return_format: 'full',
    metadata: {},
    ...overrides,
  };
}

const minimalConfig: AlduinConfig = {
  orchestrator: {
    model: 'anthropic/claude-sonnet-4-6',
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  },
  executors: {
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
  },
  providers: {
    anthropic: { api_key_env: 'ANTHROPIC_API_KEY' },
    openai: { api_key_env: 'OPENAI_API_KEY' },
  },
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: {
    daily_limit_usd: 10.0,
    per_task_limit_usd: 2.0,
    warning_threshold: 0.8,
  },
};

describe('ExecutorDispatcher', () => {
  let registry: ProviderRegistry;
  let provider: ReturnType<typeof mockProvider>;
  let budgetGuard: BudgetGuard;
  let summarizer: ResultSummarizer;
  let tokenCounter: TokenCounter;
  let dispatcher: ExecutorDispatcher;

  beforeEach(() => {
    vi.clearAllMocks();

    registry = new ProviderRegistry();
    provider = mockProvider('anthropic');
    registry.register('anthropic', provider);

    const tracker = new BudgetTracker(minimalConfig.budgets);
    budgetGuard = new BudgetGuard(tracker);
    tokenCounter = new TokenCounter();

    summarizer = new ResultSummarizer(registry, {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 300,
    });

    dispatcher = new ExecutorDispatcher(
      registry,
      minimalConfig,
      budgetGuard,
      summarizer,
      tokenCounter
    );
  });

  it('returns a complete result with usage stats on successful dispatch', async () => {
    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'function hello() { return "Hello World"; }',
        usage: { input_tokens: 50, output_tokens: 20 },
        model: 'claude-sonnet-4-6',
        finish_reason: 'stop',
      },
    });

    const result = await dispatcher.dispatch(makeTask());

    expect(result.status).toBe('complete');
    expect(result.task_id).toBe('task-1');
    expect(result.executor_name).toBe('code');
    expect(result.full_output).toBe('function hello() { return "Hello World"; }');
    expect(result.usage.input_tokens).toBe(50);
    expect(result.usage.output_tokens).toBe(20);
    expect(result.usage.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.usage.cost_usd).toBe(0.01);
  });

  it('returns failed result for an unknown executor', async () => {
    const task = makeTask({ executor_name: 'nonexistent' });
    const result = await dispatcher.dispatch(task);

    expect(result.status).toBe('failed');
    expect(result.error?.type).toBe('config_error');
    expect(result.error?.message).toContain('Unknown executor');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns budget_exceeded when budget is exhausted', async () => {
    // Exhaust the budget first
    const tracker = new BudgetTracker({
      ...minimalConfig.budgets,
      daily_limit_usd: 0.01,
    });
    tracker.trackUsage('t0', 'anthropic/claude-sonnet-4-6', { input_tokens: 100, output_tokens: 50 }, 0.02);
    const guard = new BudgetGuard(tracker);

    const exhaustedDispatcher = new ExecutorDispatcher(
      registry, minimalConfig, guard, summarizer, tokenCounter
    );

    const result = await exhaustedDispatcher.dispatch(makeTask());

    expect(result.status).toBe('budget_exceeded');
    expect(result.error?.type).toBe('budget_exceeded');
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it('returns timeout status when the call exceeds timeout_ms', async () => {
    // Simulate a provider that takes longer than the timeout
    provider.complete.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({
        ok: true,
        value: {
          content: 'late',
          usage: { input_tokens: 0, output_tokens: 0 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop' as const,
        },
      }), 500))
    );

    const task = makeTask({ timeout_ms: 50 });
    const result = await dispatcher.dispatch(task);

    expect(result.status).toBe('timeout');
    expect(result.error?.type).toBe('timeout');
  });

  it('dispatches multiple tasks concurrently via dispatchParallel', async () => {
    const callOrder: number[] = [];

    provider.complete.mockImplementation(async () => {
      const idx = callOrder.length;
      callOrder.push(idx);
      // Small delay to simulate async work
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        value: {
          content: `Result ${idx}`,
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop' as const,
        },
      };
    });

    const tasks = [
      makeTask({ id: 'p1', executor_name: 'code' }),
      makeTask({ id: 'p2', executor_name: 'code' }),
      makeTask({ id: 'p3', executor_name: 'code' }),
    ];

    const results = await dispatcher.dispatchParallel(tasks);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'complete')).toBe(true);
    expect(results.map((r) => r.task_id)).toEqual(['p1', 'p2', 'p3']);
    // All three should have been started (complete call count)
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });

  it('handles empty parallel dispatch', async () => {
    const results = await dispatcher.dispatchParallel([]);
    expect(results).toHaveLength(0);
  });
});
