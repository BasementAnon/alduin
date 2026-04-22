import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorLoop } from './loop.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ExecutorDispatcher } from '../executor/dispatch.js';
import { BudgetTracker, BudgetGuard } from '../tokens/budget.js';
import { TokenCounter } from '../tokens/counter.js';
import { ResultSummarizer } from '../executor/summarizer.js';
import { TraceLogger } from '../trace/logger.js';
import type { AlduinConfig } from '../config/types.js';
import type { LLMProvider, ConversationTurn } from '../types/llm.js';

/** Mock provider where `complete` is a vi.fn() */
function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    complete: vi.fn(),
    countTokens: () => 0,
    estimateCost: () => 0.01,
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
    code: {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 8000,
      tools: ['file_read', 'file_write'],
      context: 'task_only',
    },
    research: {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 4000,
      tools: ['web_search'],
      context: 'task_only',
    },
  },
  providers: { anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10.0, per_task_limit_usd: 2.0, warning_threshold: 0.8 },
};

describe('OrchestratorLoop', () => {
  let provider: ReturnType<typeof mockProvider>;
  let registry: ProviderRegistry;
  let loop: OrchestratorLoop;
  let traceLogger: TraceLogger;

  beforeEach(() => {
    vi.clearAllMocks();

    provider = mockProvider('anthropic');
    registry = new ProviderRegistry();
    registry.register('anthropic', provider);

    const tracker = new BudgetTracker(testConfig.budgets);
    const budgetGuard = new BudgetGuard(tracker);
    const tokenCounter = new TokenCounter();
    traceLogger = new TraceLogger();

    const summarizer = new ResultSummarizer(registry, {
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 300,
    });

    const dispatcher = new ExecutorDispatcher(
      registry,
      testConfig,
      budgetGuard,
      summarizer,
      tokenCounter
    );

    loop = new OrchestratorLoop(
      testConfig,
      registry,
      dispatcher,
      budgetGuard,
      tokenCounter,
      traceLogger
    );
  });

  it('returns reasoning as response for conversational messages (empty steps)', async () => {
    const conversationalPlan = JSON.stringify({
      reasoning: "Hello! I'm Alduin. How can I help you today?",
      steps: [],
      estimated_total_cost: 0,
      can_parallelize: false,
    });

    provider.complete.mockResolvedValue({
      ok: true,
      value: {
        content: conversationalPlan,
        usage: { input_tokens: 100, output_tokens: 30 },
        model: 'claude-sonnet-4-6',
        finish_reason: 'stop',
      },
    });

    const { response, trace } = await loop.processMessage('Hey, how are you?', []);

    expect(response).toBe("Hello! I'm Alduin. How can I help you today?");
    expect(trace.completed_at).toBeInstanceOf(Date);
    // Only the planning call — no executor or synthesis calls
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });

  it('dispatches a single-step plan to the executor and synthesizes result', async () => {
    const plan = JSON.stringify({
      reasoning: 'Single code task',
      steps: [{
        step_index: 0,
        executor: 'code',
        instruction: 'Write a hello world function in TypeScript.',
        depends_on: [],
        estimated_tokens: 2000,
      }],
      estimated_total_cost: 0.02,
      can_parallelize: false,
    });

    // Call 1: orchestrator planning
    // Call 2: executor dispatch
    // Call 3: synthesis
    provider.complete
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: plan,
          usage: { input_tokens: 200, output_tokens: 50 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'export function hello() { return "Hello World"; }',
          usage: { input_tokens: 100, output_tokens: 30 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'I created a hello world function for you.',
          usage: { input_tokens: 80, output_tokens: 20 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      });

    const { response, trace } = await loop.processMessage('Write hello world', []);

    expect(response).toBe('I created a hello world function for you.');
    // 3 calls: plan + executor + synthesis
    expect(provider.complete).toHaveBeenCalledTimes(3);
    expect(trace.completed_at).toBeInstanceOf(Date);

    // Check trace has the right events
    const planEvent = trace.events.find(e => e.event_type === 'plan_created');
    expect(planEvent).toBeDefined();
    const execCompletedEvents = trace.events.filter(e => e.event_type === 'executor_completed');
    expect(execCompletedEvents).toHaveLength(1);
  });

  it('executes multi-step plan with dependencies in order', async () => {
    const plan = JSON.stringify({
      reasoning: 'Research then code',
      steps: [
        {
          step_index: 0,
          executor: 'research',
          instruction: 'Research best practices for login forms.',
          depends_on: [],
          estimated_tokens: 2000,
        },
        {
          step_index: 1,
          executor: 'code',
          instruction: 'Implement a login form based on research.',
          depends_on: [0],
          input_from: 0,
          estimated_tokens: 4000,
        },
      ],
      estimated_total_cost: 0.05,
      can_parallelize: false,
    });

    const callOrder: string[] = [];

    provider.complete
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: plan,
          usage: { input_tokens: 200, output_tokens: 60 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      })
      .mockImplementationOnce(async (req) => {
        callOrder.push('research');
        return {
          ok: true,
          value: {
            content: 'Use semantic HTML, aria labels, and server-side validation.',
            usage: { input_tokens: 100, output_tokens: 40 },
            model: 'claude-sonnet-4-6',
            finish_reason: 'stop',
          },
        };
      })
      .mockImplementationOnce(async (req) => {
        callOrder.push('code');
        // Verify it received the research result as input
        const userMsg = (req as { messages: Array<{ content: string }> }).messages.find(
          m => m.content.includes('Input Data:')
        );
        expect(userMsg).toBeDefined();
        return {
          ok: true,
          value: {
            content: '<form>...</form>',
            usage: { input_tokens: 150, output_tokens: 80 },
            model: 'claude-sonnet-4-6',
            finish_reason: 'stop',
          },
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'Built a login form with best practices applied.',
          usage: { input_tokens: 100, output_tokens: 20 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      });

    const { response } = await loop.processMessage('Build a login form', []);

    // Research should run before code
    expect(callOrder).toEqual(['research', 'code']);
    expect(response).toBe('Built a login form with best practices applied.');
  });

  it('retries once on JSON parse failure and succeeds', async () => {
    const validPlan = JSON.stringify({
      reasoning: "I'm Alduin, here to help!",
      steps: [],
      estimated_total_cost: 0,
      can_parallelize: false,
    });

    // First call: invalid JSON
    provider.complete
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'Sure, I can help with that! Let me think...',
          usage: { input_tokens: 50, output_tokens: 20 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      })
      // Retry: valid JSON
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: validPlan,
          usage: { input_tokens: 60, output_tokens: 25 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      });

    const { response } = await loop.processMessage('Hello!', []);

    expect(response).toBe("I'm Alduin, here to help!");
    // Two calls: initial + retry
    expect(provider.complete).toHaveBeenCalledTimes(2);

    // Verify the retry message was included
    const secondCallMessages = provider.complete.mock.calls[1]?.[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    const retryMsg = secondCallMessages.find(m =>
      m.content.includes('not valid JSON')
    );
    expect(retryMsg).toBeDefined();
  });

  it('returns fallback message when both parse attempts fail', async () => {
    // Both attempts return non-JSON
    provider.complete
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'This is not JSON at all',
          usage: { input_tokens: 50, output_tokens: 10 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'Still not JSON sorry',
          usage: { input_tokens: 50, output_tokens: 10 },
          model: 'claude-sonnet-4-6',
          finish_reason: 'stop',
        },
      });

    const { response } = await loop.processMessage('Do something', []);

    expect(response).toBe(
      "I had trouble processing that request. Could you rephrase it?"
    );
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });
});
