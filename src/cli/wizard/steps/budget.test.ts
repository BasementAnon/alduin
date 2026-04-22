import { describe, it, expect } from 'vitest';
import { buildBudgetConfig } from './budget.js';

describe('buildBudgetConfig', () => {
  it('sets daily_limit_usd from answers', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8 });
    expect(b.daily_limit_usd).toBe(10);
  });

  it('sets warning_threshold from answers', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.9 });
    expect(b.warning_threshold).toBe(0.9);
  });

  it('auto-computes per_task_limit_usd as 20% of daily, capped at $2', () => {
    // 20% of $10 = $2 → capped at $2
    expect(buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8 }).per_task_limit_usd).toBe(2);
    // 20% of $50 = $10 → capped at $2
    expect(buildBudgetConfig({ dailyLimitUsd: 50, warningThreshold: 0.8 }).per_task_limit_usd).toBe(2);
    // 20% of $5 = $1 → not capped
    expect(buildBudgetConfig({ dailyLimitUsd: 5, warningThreshold: 0.8 }).per_task_limit_usd).toBe(1);
  });

  it('does not include per_model_limits when undefined', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8 });
    expect(b.per_model_limits).toBeUndefined();
  });

  it('does not include per_model_limits when empty object provided', () => {
    const b = buildBudgetConfig({
      dailyLimitUsd: 10,
      warningThreshold: 0.8,
      perModelLimits: {},
    });
    expect(b.per_model_limits).toBeUndefined();
  });

  it('includes per_model_limits when non-empty', () => {
    const b = buildBudgetConfig({
      dailyLimitUsd: 20,
      warningThreshold: 0.8,
      perModelLimits: { 'anthropic/claude-opus-4-6': 5, 'openai/gpt-4.1': 3 },
    });
    expect(b.per_model_limits).toEqual({
      'anthropic/claude-opus-4-6': 5,
      'openai/gpt-4.1': 3,
    });
  });

  it('produces a valid BudgetConfig shape', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 15, warningThreshold: 0.75 });
    expect(typeof b.daily_limit_usd).toBe('number');
    expect(typeof b.per_task_limit_usd).toBe('number');
    expect(typeof b.warning_threshold).toBe('number');
    expect(b.daily_limit_usd).toBeGreaterThan(0);
    expect(b.per_task_limit_usd).toBeGreaterThan(0);
    expect(b.warning_threshold).toBeGreaterThanOrEqual(0);
    expect(b.warning_threshold).toBeLessThanOrEqual(1);
  });
});
