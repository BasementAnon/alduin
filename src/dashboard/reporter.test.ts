import { describe, it, expect, beforeEach } from 'vitest';
import { UsageReporter } from './reporter.js';
import { CliDashboard } from './cli-ui.js';
import { BudgetTracker } from '../tokens/budget.js';
import { TraceLogger } from '../trace/logger.js';
import type { BudgetConfig } from '../config/types.js';

const budgetConfig: BudgetConfig = {
  daily_limit_usd: 10.0,
  per_task_limit_usd: 2.0,
  warning_threshold: 0.8,
};

describe('UsageReporter', () => {
  let tracker: BudgetTracker;
  let traceLogger: TraceLogger;
  let reporter: UsageReporter;

  beforeEach(() => {
    tracker = new BudgetTracker(budgetConfig);
    traceLogger = new TraceLogger();
    reporter = new UsageReporter(tracker, traceLogger);
  });

  it('getDailyReport returns correct structure with zero usage', () => {
    const report = reporter.getDailyReport();

    expect(report).toHaveProperty('date');
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.total_cost_usd).toBe(0);
    expect(report.total_tasks).toBe(0);
    expect(report.budget_remaining_usd).toBe(10.0);
    expect(report.budget_pct_used).toBe(0);
    expect(report.total_tokens).toEqual({ input: 0, output: 0 });
  });

  it('getDailyReport reflects tracked usage', () => {
    tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 500, output_tokens: 200 }, 0.50);

    // Add a completed trace with executor event
    traceLogger.startTrace('task-1', 'Test task');
    traceLogger.logEvent('task-1', {
      event_type: 'executor_completed',
      data: {
        executor: 'code',
        model: 'anthropic/claude-sonnet-4-6',
        tokens_in: 500,
        tokens_out: 200,
        cost_usd: 0.50,
        latency_ms: 1000,
      },
    });
    traceLogger.completeTrace('task-1');

    const report = reporter.getDailyReport();

    expect(report.total_cost_usd).toBeCloseTo(0.50);
    expect(report.budget_remaining_usd).toBeCloseTo(9.50);
    expect(report.budget_pct_used).toBeCloseTo(5.0);
    expect(report.total_tasks).toBe(1);
    expect(report.total_tokens.input).toBe(500);
    expect(report.total_tokens.output).toBe(200);
    expect(report.by_executor['code']).toBeDefined();
    expect(report.by_executor['code'].tasks).toBe(1);
  });

  it('getTaskReport returns null for unknown task', () => {
    expect(reporter.getTaskReport('nonexistent')).toBeNull();
  });

  it('getTaskReport returns formatted summary for known task', () => {
    traceLogger.startTrace('t1', 'hello');
    traceLogger.logEvent('t1', {
      event_type: 'executor_completed',
      data: { executor: 'code', cost_usd: 0.01, tokens_in: 50, tokens_out: 20, latency_ms: 500 },
    });
    traceLogger.completeTrace('t1');

    const report = reporter.getTaskReport('t1');
    expect(report).not.toBeNull();
    expect(report).toContain('code');
  });
});

describe('CliDashboard', () => {
  let tracker: BudgetTracker;
  let traceLogger: TraceLogger;
  let reporter: UsageReporter;
  let dashboard: CliDashboard;

  beforeEach(() => {
    tracker = new BudgetTracker(budgetConfig);
    traceLogger = new TraceLogger();
    reporter = new UsageReporter(tracker, traceLogger);
    dashboard = new CliDashboard(reporter);
  });

  it('renderDailySummary returns a non-empty string with box characters', () => {
    const output = dashboard.renderDailySummary();
    expect(output).toContain('┌');
    expect(output).toContain('┘');
    expect(output).toContain('Alduin Daily Usage');
    expect(output).toContain('Total:');
  });

  it('renderDailySummary shows warning when budget is over 80%', () => {
    // Use $8.50 of $10 = 85%
    tracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 8.5);

    const output = dashboard.renderDailySummary();
    expect(output).toContain('Warning');
    expect(output).toContain('%');
  });

  it('renderDailySummary does not show warning when under 80%', () => {
    tracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 5.0);

    const output = dashboard.renderDailySummary();
    expect(output).not.toContain('Warning');
  });

  it('renderTaskTrace returns "Trace not found." for unknown task', () => {
    expect(dashboard.renderTaskTrace('ghost')).toBe('Trace not found.');
  });

  it('renderStatus formats the one-line status correctly', () => {
    const status = dashboard.renderStatus({
      hot_turns: 2,
      warm_tokens: 150,
      cold_entries: 3,
      session_cost: 0.0512,
    });
    expect(status).toContain('2 hot');
    expect(status).toContain('150tok warm');
    expect(status).toContain('3 cold');
    expect(status).toContain('Session: $0.0512');
  });
});
