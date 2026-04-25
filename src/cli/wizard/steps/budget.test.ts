import { describe, it, expect } from 'vitest';
import { buildBudgetConfig } from './budget.js';

describe('buildBudgetConfig', () => {
  it('sets daily_limit_usd from answers', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8, perTaskLimitUsd: 2 });
    expect(b.daily_limit_usd).toBe(10);
  });

  it('sets warning_threshold from answers', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.9, perTaskLimitUsd: 2 });
    expect(b.warning_threshold).toBe(0.9);
  });

  it('sets per_task_limit_usd from answers', () => {
    expect(buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8, perTaskLimitUsd: 2 }).per_task_limit_usd).toBe(2);
    expect(buildBudgetConfig({ dailyLimitUsd: 50, warningThreshold: 0.8, perTaskLimitUsd: 5 }).per_task_limit_usd).toBe(5);
    expect(buildBudgetConfig({ dailyLimitUsd: 5, warningThreshold: 0.8, perTaskLimitUsd: 1 }).per_task_limit_usd).toBe(1);
  });

  it('does not include per_model_limits when undefined', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8, perTaskLimitUsd: 2 });
    expect(b.per_model_limits).toBeUndefined();
  });

  it('does not include per_model_limits when empty object provided', () => {
    const b = buildBudgetConfig({
      dailyLimitUsd: 10,
      warningThreshold: 0.8,
      perTaskLimitUsd: 2,
      perModelLimits: {},
    });
    expect(b.per_model_limits).toBeUndefined();
  });

  it('includes per_model_limits when non-empty', () => {
    const b = buildBudgetConfig({
      dailyLimitUsd: 20,
      warningThreshold: 0.8,
      perTaskLimitUsd: 2,
      perModelLimits: { 'anthropic/claude-opus-4-6': 5, 'openai/gpt-4.1': 3 },
    });
    expect(b.per_model_limits).toEqual({
      'anthropic/claude-opus-4-6': 5,
      'openai/gpt-4.1': 3,
    });
  });

  it('produces a valid BudgetConfig shape', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 15, warningThreshold: 0.75, perTaskLimitUsd: 2 });
    expect(typeof b.daily_limit_usd).toBe('number');
    expect(typeof b.per_task_limit_usd).toBe('number');
    expect(typeof b.warning_threshold).toBe('number');
    expect(b.daily_limit_usd).toBeGreaterThan(0);
    expect(b.per_task_limit_usd).toBeGreaterThan(0);
    expect(b.warning_threshold).toBeGreaterThanOrEqual(0);
    expect(b.warning_threshold).toBeLessThanOrEqual(1);
  });

  it('accepts daily_limit_usd = 0 (no daily cap)', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 0, warningThreshold: 0, perTaskLimitUsd: 0.5 });
    expect(b.daily_limit_usd).toBe(0);
    expect(b.per_task_limit_usd).toBe(0.5);
  });

  it('accepts per_task_limit_usd = 0 (no per-task cap)', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 10, warningThreshold: 0.8, perTaskLimitUsd: 0 });
    expect(b.per_task_limit_usd).toBe(0);
  });

  it('accepts both limits as 0 (fully unlimited)', () => {
    const b = buildBudgetConfig({ dailyLimitUsd: 0, warningThreshold: 0, perTaskLimitUsd: 0 });
    expect(b.daily_limit_usd).toBe(0);
    expect(b.per_task_limit_usd).toBe(0);
  });
});
