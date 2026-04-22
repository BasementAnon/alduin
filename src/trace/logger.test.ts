import { describe, it, expect, beforeEach } from 'vitest';
import { TraceLogger } from './logger.js';

describe('TraceLogger', () => {
  let logger: TraceLogger;
  const taskId = 'trace-test-1';

  beforeEach(() => {
    logger = new TraceLogger();
  });

  it('starts a trace and stores it', () => {
    const trace = logger.startTrace(taskId, 'Hello world');
    expect(trace.task_id).toBe(taskId);
    expect(trace.user_message).toBe('Hello world');
    expect(trace.started_at).toBeInstanceOf(Date);
    expect(trace.events).toHaveLength(0);
    expect(trace.total_cost_usd).toBe(0);
    expect(trace.total_tokens).toEqual({ input: 0, output: 0 });

    expect(logger.getTrace(taskId)).toBe(trace);
  });

  it('logs events and accumulates running totals', () => {
    logger.startTrace(taskId, 'Build a login page');

    logger.logEvent(taskId, {
      event_type: 'executor_started',
      data: { executor: 'code', model: 'claude-sonnet-4-6' },
    });

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: {
        executor: 'code',
        model: 'claude-sonnet-4-6',
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.02,
        latency_ms: 3100,
      },
    });

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: {
        executor: 'research',
        model: 'gpt-4.1',
        tokens_in: 800,
        tokens_out: 200,
        cost_usd: 0.08,
        latency_ms: 4700,
      },
    });

    const trace = logger.getTrace(taskId)!;
    expect(trace.events).toHaveLength(3);
    expect(trace.total_cost_usd).toBeCloseTo(0.10);
    expect(trace.total_tokens.input).toBe(1800);
    expect(trace.total_tokens.output).toBe(700);
    expect(trace.total_latency_ms).toBe(7800);
  });

  it('completes a trace and sets completed_at', () => {
    logger.startTrace(taskId, 'Test task');
    const trace = logger.completeTrace(taskId);

    expect(trace).toBeDefined();
    expect(trace!.completed_at).toBeInstanceOf(Date);
  });

  it('returns undefined for unknown trace IDs', () => {
    expect(logger.getTrace('nonexistent')).toBeUndefined();
    expect(logger.completeTrace('nonexistent')).toBeUndefined();
  });

  it('does nothing when logging to a nonexistent trace', () => {
    // Should not throw
    logger.logEvent('ghost', {
      event_type: 'executor_completed',
      data: { cost_usd: 100 },
    });
  });

  it('formatTraceSummary produces correct format', () => {
    logger.startTrace(taskId, 'Build a login page');

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: {
        executor: 'code',
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.02,
        latency_ms: 3100,
      },
    });

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: {
        executor: 'research',
        tokens_in: 800,
        tokens_out: 200,
        cost_usd: 0.08,
        latency_ms: 4700,
      },
    });

    const summary = logger.formatTraceSummary(taskId);
    // Should contain step names with timing and cost
    expect(summary).toContain('code(3.1s,$0.02)');
    expect(summary).toContain('research(4.7s,$0.08)');
    expect(summary).toContain('→');
    // Should contain totals
    expect(summary).toContain('Total: $0.10');
    expect(summary).toContain('2,500 tokens');
    expect(summary).toContain('7.8s');
  });

  it('formatTraceSummary shows "no steps" for an empty trace', () => {
    logger.startTrace(taskId, 'Just chatting');
    const summary = logger.formatTraceSummary(taskId);
    expect(summary).toContain('no steps');
  });

  it('formatTraceSummary handles unknown task', () => {
    const summary = logger.formatTraceSummary('unknown');
    expect(summary).toContain('not found');
  });

  // ── Tree trace formatting (recursion) ──────────────────────────────────

  it('formatTraceTree falls back to flat summary when no recursion', () => {
    logger.startTrace(taskId, 'Simple task');

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: { executor: 'code', cost_usd: 0.02, latency_ms: 3000 },
    });

    const tree = logger.formatTraceTree(taskId);
    // Should fall back to flat format
    expect(tree).toContain('code(3.0s,$0.02)');
    expect(tree).toContain('Total: $0.02');
  });

  it('formatTraceTree renders recursion as indented tree', () => {
    logger.startTrace(taskId, 'Recursive task');

    logger.logEvent(taskId, {
      event_type: 'plan_created',
      data: { model: 'sonnet' },
    });

    logger.logEvent(taskId, {
      event_type: 'child_orchestration_started',
      data: { child_model: 'qwen', depth: 1, parent_task_id: taskId },
    });

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: { executor: 'search', model: 'qwen', cost_usd: 0, latency_ms: 1200 },
    });

    logger.logEvent(taskId, {
      event_type: 'child_orchestration_completed',
      data: {
        child_model: 'qwen',
        child_cost_usd: 0,
        depth: 1,
        child_task_id: 'child-1',
        cost_usd: 0,
        latency_ms: 2000,
      },
    });

    logger.logEvent(taskId, {
      event_type: 'executor_completed',
      data: { executor: 'write', model: 'sonnet', cost_usd: 0.04, latency_ms: 3200 },
    });

    logger.logEvent(taskId, {
      event_type: 'synthesis_completed',
      data: { model: 'sonnet', cost_usd: 0.01, latency_ms: 1100 },
    });

    const tree = logger.formatTraceTree(taskId);

    // Should contain tree markers
    expect(tree).toContain('▸ plan');
    expect(tree).toContain('sub-orchestrate → qwen');
    expect(tree).toContain('child result');
    expect(tree).toContain('write via sonnet');
    expect(tree).toContain('synthesize');
    expect(tree).toContain('Σ');

    // Child events should be indented (contain leading spaces)
    const lines = tree.split('\n');
    const searchLine = lines.find((l) => l.includes('search'));
    expect(searchLine).toBeTruthy();
    expect(searchLine!.startsWith('  ')).toBe(true);

    // Summary line should include call count and depth
    const summaryLine = lines.find((l) => l.startsWith('Σ'));
    expect(summaryLine).toBeTruthy();
    expect(summaryLine).toContain('depth max 1');
  });

  it('formatTraceTree handles unknown task', () => {
    const tree = logger.formatTraceTree('unknown');
    expect(tree).toContain('not found');
  });

  it('formatTraceTree shows FAILED status for failed child orchestrations', () => {
    logger.startTrace(taskId, 'Failed recursion');

    logger.logEvent(taskId, {
      event_type: 'child_orchestration_started',
      data: { child_model: 'qwen', depth: 1 },
    });

    logger.logEvent(taskId, {
      event_type: 'child_orchestration_failed',
      data: {
        child_model: 'qwen',
        child_cost_usd: 0,
        depth: 1,
        error: 'depth exceeded',
        cost_usd: 0,
        latency_ms: 100,
      },
    });

    const tree = logger.formatTraceTree(taskId);
    expect(tree).toContain('FAILED');
  });
});
