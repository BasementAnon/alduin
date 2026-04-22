import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from './router.js';
import { MessageClassifier } from './classifier.js';
import { OrchestratorLoop } from '../orchestrator/loop.js';
import { ExecutorDispatcher } from '../executor/dispatch.js';
import { TraceLogger } from '../trace/logger.js';
import { TokenCounter } from '../tokens/counter.js';
import type { AlduinConfig } from '../config/types.js';
import type { ExecutorResult } from '../executor/types.js';
import type { TaskTrace } from '../trace/types.js';
import type { PolicyVerdict } from '../auth/policy.js';

// ── shared test config ──────────────────────────────────────────────────────
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
    classifier: {
      model: 'ollama/qwen2.5-7b',
      max_tokens: 200,
      tools: [],
      context: 'message_only',
    },
  },
  providers: { anthropic: { api_key_env: 'ANTHROPIC_API_KEY' } },
  routing: {
    pre_classifier: true,
    classifier_model: 'classifier',
    complexity_threshold: 0.6,
  },
  budgets: { daily_limit_usd: 10.0, per_task_limit_usd: 2.0, warning_threshold: 0.8 },
};

// ── Policy verdicts for testing ────────────────────────────────────────────
const permissiveVerdict: PolicyVerdict = {
  allowed: true,
  allowed_skills: ['*'],
  allowed_connectors: ['*'],
  allowed_executors: ['*'],
  cost_ceiling_usd: 2.0,
  model_tier_max: 'frontier',
  allowed_attachment_kinds: ['image', 'document'],
  requires_confirmation: [],
};

const restrictedVerdict: PolicyVerdict = {
  allowed: true,
  allowed_skills: [],
  allowed_connectors: [],
  allowed_executors: ['code', 'research'], // quick is NOT allowed
  cost_ceiling_usd: 2.0,
  model_tier_max: 'frontier',
  allowed_attachment_kinds: ['image'],
  requires_confirmation: [],
};

// ── helpers ─────────────────────────────────────────────────────────────────
function makeFakeTrace(): TaskTrace {
  return {
    task_id: 'fake-trace',
    user_message: 'test',
    started_at: new Date(),
    completed_at: new Date(),
    events: [],
    total_cost_usd: 0,
    total_tokens: { input: 0, output: 0 },
    total_latency_ms: 0,
  };
}

function makeSuccessResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    task_id: 'r1',
    executor_name: 'code',
    status: 'complete',
    summary: 'Done',
    full_output: 'Detailed output',
    usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.01, latency_ms: 300 },
    ...overrides,
  };
}

describe('Router', () => {
  let classifier: MessageClassifier;
  let orchestratorLoop: OrchestratorLoop;
  let dispatcher: ExecutorDispatcher;
  let traceLogger: TraceLogger;
  let tokenCounter: TokenCounter;
  let router: Router;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock all dependencies
    classifier = {
      classify: vi.fn(),
    } as unknown as MessageClassifier;

    orchestratorLoop = {
      processMessage: vi.fn().mockResolvedValue({
        response: 'Orchestrator response',
        trace: makeFakeTrace(),
      }),
    } as unknown as OrchestratorLoop;

    dispatcher = {
      dispatch: vi.fn(),
    } as unknown as ExecutorDispatcher;

    traceLogger = new TraceLogger();
    tokenCounter = new TokenCounter();

    router = new Router(
      testConfig,
      classifier,
      orchestratorLoop,
      dispatcher,
      traceLogger,
      tokenCounter
    );
  });

  it('bypasses classifier and goes to orchestrator when pre_classifier is disabled', async () => {
    const configWithoutClassifier: AlduinConfig = {
      ...testConfig,
      routing: { ...testConfig.routing, pre_classifier: false },
    };

    const r = new Router(
      configWithoutClassifier,
      classifier,
      orchestratorLoop,
      dispatcher,
      traceLogger,
      tokenCounter
    );

    const { response } = await r.route('Write me some code', [], permissiveVerdict);

    expect(response).toBe('Orchestrator response');
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(orchestratorLoop.processMessage).toHaveBeenCalledWith(
      'Write me some code',
      [],
      permissiveVerdict
    );
  });

  it('dispatches directly to code executor on high-confidence code request', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'medium',
        category: 'code',
        suggested_executor: 'code',
        needs_orchestrator: false,
        confidence: 0.9,
        reasoning: 'Single code task',
      },
    });

    vi.mocked(dispatcher.dispatch).mockResolvedValue(makeSuccessResult());

    const { response } = await router.route('Write a quicksort function', [], permissiveVerdict);

    // Direct dispatch — no orchestrator
    expect(orchestratorLoop.processMessage).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(response).toBe('Detailed output');
  });

  it('routes to orchestrator for multi-step requests', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'high',
        category: 'multi_step',
        suggested_executor: null,
        needs_orchestrator: true,
        confidence: 0.9,
        reasoning: 'Multi-step task',
      },
    });

    const { response } = await router.route('Research AI trends and write a report', [], permissiveVerdict);

    expect(response).toBe('Orchestrator response');
    expect(orchestratorLoop.processMessage).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls through to orchestrator when confidence is below complexity_threshold', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'medium',
        category: 'code',
        suggested_executor: 'code',
        needs_orchestrator: false,
        confidence: 0.4, // below 0.6 threshold
        reasoning: 'Ambiguous request',
      },
    });

    const { response } = await router.route('Do something with code maybe', [], permissiveVerdict);

    expect(response).toBe('Orchestrator response');
    expect(orchestratorLoop.processMessage).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to orchestrator when direct executor dispatch fails', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'medium',
        category: 'code',
        suggested_executor: 'code',
        needs_orchestrator: false,
        confidence: 0.9,
        reasoning: 'Single code task',
      },
    });

    vi.mocked(dispatcher.dispatch).mockResolvedValue(
      makeSuccessResult({
        status: 'failed',
        error: { type: 'provider_error', message: 'API down' },
        full_output: undefined,
      })
    );

    const { response } = await router.route('Write a function', [], permissiveVerdict);

    // Should recover to orchestrator
    expect(orchestratorLoop.processMessage).toHaveBeenCalledOnce();
    expect(response).toBe('Orchestrator response');
  });

  it('falls through to orchestrator when classifier returns an error', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: false,
      error: {
        type: 'provider_error' as const,
        message: 'Classifier is down',
        retryable: false,
      },
    });

    const { response } = await router.route('Hello', [], permissiveVerdict);

    expect(response).toBe('Orchestrator response');
    expect(orchestratorLoop.processMessage).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('routes conversation with null suggested_executor through orchestrator', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'low',
        category: 'conversation',
        suggested_executor: null,
        needs_orchestrator: false,
        confidence: 0.95,
        reasoning: 'Simple greeting',
      },
    });

    const { response } = await router.route('Hey!', [], permissiveVerdict);

    // No suggested executor → orchestrator handles (returns immediately for conversational)
    expect(orchestratorLoop.processMessage).toHaveBeenCalledOnce();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(response).toBe('Orchestrator response');
  });

  it('denies a disallowed executor in the direct dispatch path', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'low',
        category: 'calendar',
        suggested_executor: 'quick', // quick is NOT in restrictedVerdict
        needs_orchestrator: false,
        confidence: 0.9,
        reasoning: 'Quick task',
      },
    });

    const { response } = await router.route('Add a calendar event', [], restrictedVerdict);

    // Dispatcher should NOT be called (policy enforcement blocks it)
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    // Response should contain policy violation message
    expect(response).toContain('Policy violation');
    expect(response).toContain('quick');
  });

  it('denies a disallowed executor in the orchestrator path', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'high',
        category: 'multi_step',
        suggested_executor: null,
        needs_orchestrator: true,
        confidence: 0.9,
        reasoning: 'Complex task',
      },
    });

    vi.mocked(orchestratorLoop.processMessage).mockResolvedValue({
      response: 'Orchestrator handled policy enforcement',
      trace: makeFakeTrace(),
    });

    const { response } = await router.route('Complex request', [], restrictedVerdict);

    // Orchestrator should be called with the restricted verdict
    expect(orchestratorLoop.processMessage).toHaveBeenCalledWith(
      'Complex request',
      [],
      restrictedVerdict
    );
    expect(response).toBe('Orchestrator handled policy enforcement');
  });

  it('allows wildcard executors in verdict', async () => {
    vi.mocked(classifier.classify).mockResolvedValue({
      ok: true,
      value: {
        complexity: 'low',
        category: 'calendar',
        suggested_executor: 'quick',
        needs_orchestrator: false,
        confidence: 0.9,
        reasoning: 'Quick task',
      },
    });

    const successResult: ExecutorResult = {
      task_id: 'r1',
      executor_name: 'quick',
      status: 'complete',
      summary: 'Calendar event added',
      full_output: 'Added to calendar',
      usage: { input_tokens: 50, output_tokens: 25, cost_usd: 0.001, latency_ms: 200 },
    };

    vi.mocked(dispatcher.dispatch).mockResolvedValue(successResult);

    // permissiveVerdict has '*' for allowed_executors
    const { response } = await router.route('Add a calendar event', [], permissiveVerdict);

    expect(dispatcher.dispatch).toHaveBeenCalled();
    expect(response).toBe('Added to calendar');
  });
});
