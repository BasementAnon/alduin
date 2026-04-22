import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineEngine } from './engine.js';
import { ExecutorDispatcher } from '../executor/dispatch.js';
import { TraceLogger } from '../trace/logger.js';
import type { AlduinConfig } from '../config/types.js';
import type { ExecutorResult } from '../executor/types.js';
import type { PipelineDefinition } from './types.js';
import type { PolicyVerdict } from '../auth/policy.js';

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
      tools: ['file_read'],
      context: 'task_only',
    },
    research: {
      model: 'openai/gpt-4.1',
      max_tokens: 4000,
      tools: ['web_search'],
      context: 'task_only',
    },
  },
  providers: { anthropic: {} },
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
};

function successResult(content: string, overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    task_id: 'test',
    executor_name: 'code',
    status: 'complete',
    summary: content,
    full_output: content,
    usage: { input_tokens: 50, output_tokens: 30, cost_usd: 0.01, latency_ms: 100 },
    ...overrides,
  };
}

describe('PipelineEngine', () => {
  let dispatcher: ExecutorDispatcher;
  let traceLogger: TraceLogger;
  let engine: PipelineEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    dispatcher = { dispatch: vi.fn(), dispatchParallel: vi.fn() } as unknown as ExecutorDispatcher;
    traceLogger = new TraceLogger();
    engine = new PipelineEngine(dispatcher, testConfig, traceLogger);
  });

  it('runs a linear 2-step pipeline and returns completed state', async () => {
    vi.mocked(dispatcher.dispatch)
      .mockResolvedValueOnce(successResult('Step 0 output'))
      .mockResolvedValueOnce(successResult('Step 1 output'));

    const def: PipelineDefinition = {
      id: 'test-linear',
      name: 'Linear Pipeline',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Do step 0', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'code', action: 'review', instruction_template: 'Review: {step_0_result}', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    const state = await engine.run(def, 'Build something');

    expect(state.status).toBe('completed');
    expect(state.step_results.size).toBe(2);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it('replaces {step_N_result} placeholders in instruction templates', async () => {
    vi.mocked(dispatcher.dispatch)
      .mockResolvedValueOnce(successResult('The generated code'))
      .mockResolvedValueOnce(successResult('Review done'));

    const def: PipelineDefinition = {
      id: 'test-placeholder',
      name: 'Placeholder Test',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Write code', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'code', action: 'review', instruction_template: 'Review this: {step_0_result}', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    await engine.run(def, 'Initial input');

    const secondCallArg = vi.mocked(dispatcher.dispatch).mock.calls[1]?.[0];
    expect(secondCallArg?.instruction).toContain('The generated code');
  });

  it('stops pipeline with status failed on step failure', async () => {
    const failedResult: ExecutorResult = {
      task_id: 'test',
      executor_name: 'code',
      status: 'failed',
      summary: 'Something went wrong',
      error: { type: 'provider_error', message: 'API error' },
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 },
    };

    vi.mocked(dispatcher.dispatch).mockResolvedValueOnce(failedResult);

    const def: PipelineDefinition = {
      id: 'test-fail',
      name: 'Failing Pipeline',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Do something', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'code', action: 'review', instruction_template: 'Review', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    const state = await engine.run(def, 'test');

    expect(state.status).toBe('failed');
    // Second step should not have been called
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('loops until stop_condition is met within max_iterations', async () => {
    // First iteration: step 1 output does NOT contain "pass"
    // Second iteration: step 1 output DOES contain "pass"
    vi.mocked(dispatcher.dispatch)
      .mockResolvedValueOnce(successResult('impl v1'))
      .mockResolvedValueOnce(successResult('fail — needs improvement'))
      .mockResolvedValueOnce(successResult('impl v2'))
      .mockResolvedValueOnce(successResult('Code looks great, pass approved'));

    const def: PipelineDefinition = {
      id: 'test-loop',
      name: 'Looping Pipeline',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Implement', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'code', action: 'review', instruction_template: 'Review: {step_0_result}', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 3,
      stop_condition: 'step_1.pass',
    };

    const state = await engine.run(def, 'Build a feature');

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(1); // completed on the second iteration
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(4); // 2 steps × 2 iterations
  });

  it('completes after one pass when no stop_condition is defined', async () => {
    vi.mocked(dispatcher.dispatch).mockResolvedValue(successResult('done'));

    const def: PipelineDefinition = {
      id: 'test-single',
      name: 'Single Pass',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Do it', depends_on: [], output_type: 'text' },
      ],
      max_iterations: 5,
    };

    const state = await engine.run(def, 'Go');

    expect(state.status).toBe('completed');
    expect(state.iteration).toBe(0);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('prepends initialInput to the first step instruction', async () => {
    vi.mocked(dispatcher.dispatch).mockResolvedValue(successResult('output'));

    const def: PipelineDefinition = {
      id: 'test-input',
      name: 'Input Test',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Build the feature as described.', depends_on: [], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    await engine.run(def, 'INITIAL_REQUEST');

    const callArg = vi.mocked(dispatcher.dispatch).mock.calls[0]?.[0];
    expect(callArg?.instruction).toContain('INITIAL_REQUEST');
    expect(callArg?.instruction).toContain('Build the feature as described.');
  });

  it('aborts pipeline with policy_denied status when a step executor is disallowed', async () => {
    const restrictedVerdict: PolicyVerdict = {
      allowed: true,
      allowed_skills: [],
      allowed_connectors: [],
      allowed_executors: ['code'], // research is NOT allowed
      cost_ceiling_usd: 2.0,
      model_tier_max: 'frontier',
      allowed_attachment_kinds: ['image'],
      requires_confirmation: [],
    };

    // We don't expect dispatch to be called at all
    vi.mocked(dispatcher.dispatch).mockResolvedValue(successResult('code output'));

    const def: PipelineDefinition = {
      id: 'test-policy',
      name: 'Policy Violation Test',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Write code', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'research', action: 'research', instruction_template: 'Research: {step_0_result}', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    const state = await engine.run(def, 'Build something', restrictedVerdict);

    // First step succeeds (allowed executor)
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
    expect(state.step_results.has(0)).toBe(true);

    // Second step should NOT be dispatched (policy violation)
    expect(state.step_results.has(1)).toBe(false);
    expect(state.status).toBe('policy_denied');
  });

  it('passes policy_verdict to each task', async () => {
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

    vi.mocked(dispatcher.dispatch)
      .mockResolvedValueOnce(successResult('Step 0 output'))
      .mockResolvedValueOnce(successResult('Step 1 output'));

    const def: PipelineDefinition = {
      id: 'test-verdict',
      name: 'Verdict Test',
      steps: [
        { step_index: 0, executor: 'code', action: 'implement', instruction_template: 'Do step 0', depends_on: [], output_type: 'text' },
        { step_index: 1, executor: 'code', action: 'review', instruction_template: 'Review: {step_0_result}', depends_on: [0], output_type: 'text' },
      ],
      max_iterations: 1,
    };

    const state = await engine.run(def, 'Build something', permissiveVerdict);

    expect(state.status).toBe('completed');

    // Check that both tasks were called with the verdict
    const call1 = vi.mocked(dispatcher.dispatch).mock.calls[0]?.[0];
    const call2 = vi.mocked(dispatcher.dispatch).mock.calls[1]?.[0];

    expect(call1?.policy_verdict).toBe(permissiveVerdict);
    expect(call2?.policy_verdict).toBe(permissiveVerdict);
  });
});
