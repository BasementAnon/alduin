import { describe, it, expect, vi, afterEach } from 'vitest';
import { BudgetTracker, BudgetGuard, ScopedBudgetTracker } from './budget.js';
import type { BudgetConfig } from '../config/types.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseConfig: BudgetConfig = {
  daily_limit_usd: 10.0,
  per_task_limit_usd: 2.0,
  warning_threshold: 0.8,
  per_model_limits: {
    'anthropic/claude-opus-4-6': 5.0,
    'anthropic/claude-sonnet-4-6': 3.0,
  },
};

describe('BudgetTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates usage correctly across multiple calls', () => {
    const tracker = new BudgetTracker(baseConfig);

    tracker.trackUsage('task-1', 'anthropic/claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 }, 0.50);
    tracker.trackUsage('task-2', 'anthropic/claude-sonnet-4-6', { input_tokens: 2000, output_tokens: 300 }, 0.75);

    const summary = tracker.getDailySummary();
    const sonnet = summary.per_model.get('anthropic/claude-sonnet-4-6');
    expect(sonnet?.tokens).toBe(1000 + 500 + 2000 + 300);
    expect(sonnet?.cost).toBeCloseTo(1.25);
    expect(summary.total_cost).toBeCloseTo(1.25);
    expect(summary.budget_remaining).toBeCloseTo(8.75);
  });

  it('tracks different models independently', () => {
    const tracker = new BudgetTracker(baseConfig);

    tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 500, output_tokens: 200 }, 0.30);
    tracker.trackUsage('t2', 'openai/gpt-4.1', { input_tokens: 300, output_tokens: 100 }, 0.20);

    const summary = tracker.getDailySummary();
    expect(summary.per_model.size).toBe(2);
    expect(summary.total_cost).toBeCloseTo(0.50);
  });

  it('resets state when the UTC date changes', () => {
    const tmpFile = path.join(os.tmpdir(), `alduin-budget-daychange-${Date.now()}.json`);
    try {
      // Persist a state with an old date that has accumulated cost
      const oldState = {
        date: '2000-01-01',
        perModel: {
          'anthropic/claude-sonnet-4-6': { tokens: 1500, cost: 2.0 },
        },
      };
      writeFileSync(tmpFile, JSON.stringify(oldState), 'utf-8');

      // Restore — old date means it starts fresh
      const tracker = BudgetTracker.restore(tmpFile, baseConfig);

      // Since the persisted date is old, restore discards the state
      expect(tracker.getDailySummary().total_cost).toBe(0);
      expect(tracker.getDailySummary().per_model.size).toBe(0);

      // Now track fresh usage for today
      tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 500 }, 2.0);
      expect(tracker.getDailySummary().total_cost).toBeCloseTo(2.0);

      // resetIfNewDay when already on today's date should be a no-op
      tracker.resetIfNewDay();
      expect(tracker.getDailySummary().total_cost).toBeCloseTo(2.0);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  });

  it('warning threshold triggers at 80% of daily limit', () => {
    const tracker = new BudgetTracker(baseConfig);

    // Spend exactly 80% = $8.00
    tracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 8.0);

    const { warning, allowed } = tracker.checkBudget('openai/gpt-4.1');
    expect(warning).toBe(true);
    expect(allowed).toBe(true);
  });

  it('allowed is false when per-model limit is exceeded', () => {
    const tracker = new BudgetTracker(baseConfig);

    // Claude Sonnet limit = $3.00, spend $3.00
    tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 }, 3.0);

    const { allowed } = tracker.checkBudget('anthropic/claude-sonnet-4-6');
    expect(allowed).toBe(false);
  });

  it('allowed is false when daily limit is exceeded', () => {
    const tracker = new BudgetTracker(baseConfig);

    tracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 10.0);

    const { allowed, remaining_usd } = tracker.checkBudget('openai/gpt-4.1');
    expect(allowed).toBe(false);
    expect(remaining_usd).toBe(0);
  });

  it('persistence round-trip: persist then restore', () => {
    const tmpFile = path.join(os.tmpdir(), `alduin-budget-test-${Date.now()}.json`);

    try {
      const tracker = new BudgetTracker(baseConfig);
      tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 200 }, 1.50);
      tracker.trackUsage('t2', 'openai/gpt-4.1', { input_tokens: 500, output_tokens: 100 }, 0.80);

      tracker.persist(tmpFile);
      expect(existsSync(tmpFile)).toBe(true);

      const restored = BudgetTracker.restore(tmpFile, baseConfig);
      const summary = restored.getDailySummary();

      expect(summary.total_cost).toBeCloseTo(2.30);
      expect(summary.per_model.get('anthropic/claude-sonnet-4-6')?.cost).toBeCloseTo(1.50);
      expect(summary.per_model.get('openai/gpt-4.1')?.cost).toBeCloseTo(0.80);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  });

  it('restore with old date starts fresh', () => {
    const tmpFile = path.join(os.tmpdir(), `alduin-budget-old-${Date.now()}.json`);

    try {
      // Write a state with an old date
      const oldState = {
        date: '2000-01-01',
        perModel: {
          'anthropic/claude-sonnet-4-6': { tokens: 5000, cost: 3.0 },
        },
      };
      writeFileSync(tmpFile, JSON.stringify(oldState), 'utf-8');

      const restored = BudgetTracker.restore(tmpFile, baseConfig);
      const summary = restored.getDailySummary();

      // Old date → fresh start, no data
      expect(summary.total_cost).toBe(0);
      expect(summary.per_model.size).toBe(0);
    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    }
  });
});

describe('BudgetGuard', () => {
  it('preCheck returns ok when within budget', () => {
    const tracker = new BudgetTracker(baseConfig);
    const guard = new BudgetGuard(tracker);

    const result = guard.preCheck('anthropic/claude-sonnet-4-6');
    expect(result.ok).toBe(true);
  });

  it('preCheck returns ok with warning when near limit', () => {
    const tracker = new BudgetTracker(baseConfig);
    tracker.trackUsage('t1', 'openai/gpt-4.1', { input_tokens: 0, output_tokens: 0 }, 9.0);

    const guard = new BudgetGuard(tracker);
    const result = guard.preCheck('openai/gpt-4.1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warning).toBe(true);
    }
  });

  it('preCheck returns err(BudgetExceeded) when model limit is hit', () => {
    const tracker = new BudgetTracker(baseConfig);
    // Exceed the $3.00 claude-sonnet limit
    tracker.trackUsage('t1', 'anthropic/claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 }, 3.5);

    const guard = new BudgetGuard(tracker);
    const result = guard.preCheck('anthropic/claude-sonnet-4-6');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.model).toBe('anthropic/claude-sonnet-4-6');
      expect(result.error.limit).toBe(3.0);
      expect(result.error.spent).toBeCloseTo(3.5);
    }
  });

  it('postRecord delegates to trackUsage on the tracker', () => {
    const tracker = new BudgetTracker(baseConfig);
    const guard = new BudgetGuard(tracker);

    guard.postRecord('task-42', 'openai/gpt-4.1', { input_tokens: 100, output_tokens: 50 }, 0.10);

    const summary = tracker.getDailySummary();
    expect(summary.total_cost).toBeCloseTo(0.10);
  });
});

// ── ScopedBudgetTracker ───────────────────────────────────────────────────────

describe('ScopedBudgetTracker', () => {
  it('tracks spending per user', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.trackScoped('alice', undefined, 1.0);
    scoped.trackScoped('alice', undefined, 0.5);
    scoped.trackScoped('bob', undefined, 2.0);

    expect(scoped.getScopedSpend('user', 'alice')).toBeCloseTo(1.5);
    expect(scoped.getScopedSpend('user', 'bob')).toBeCloseTo(2.0);
    expect(scoped.getScopedSpend('user', 'charlie')).toBe(0);
  });

  it('tracks spending per group', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.trackScoped('alice', 'group-1', 1.0);
    scoped.trackScoped('bob', 'group-1', 0.5);
    scoped.trackScoped('alice', 'group-2', 2.0);

    expect(scoped.getScopedSpend('group', 'group-1')).toBeCloseTo(1.5);
    expect(scoped.getScopedSpend('group', 'group-2')).toBeCloseTo(2.0);
  });

  it('enforces per-user limit', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.setScopedLimit('user', 'alice', 1.0);
    scoped.trackScoped('alice', undefined, 1.0);

    const check = scoped.checkScoped('alice');
    expect(check.allowed).toBe(false);
    expect(check.denied_scope).toBe('user:alice');
  });

  it('enforces per-group limit', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.setScopedLimit('group', 'group-1', 2.0);
    scoped.trackScoped('alice', 'group-1', 2.0);

    const check = scoped.checkScoped('bob', 'group-1');
    expect(check.allowed).toBe(false);
    expect(check.denied_scope).toBe('group:group-1');
  });

  it('allows when under limit', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.setScopedLimit('user', 'alice', 5.0);
    scoped.trackScoped('alice', undefined, 2.0);

    expect(scoped.checkScoped('alice').allowed).toBe(true);
  });

  it('allows when no limit is set', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.trackScoped('alice', 'group-1', 100.0);

    expect(scoped.checkScoped('alice', 'group-1').allowed).toBe(true);
  });

  it('getScopedLimit returns 0 when no limit set', () => {
    const scoped = new ScopedBudgetTracker();
    expect(scoped.getScopedLimit('user', 'alice')).toBe(0);
  });

  it('setScopedLimit and getScopedLimit round-trip', () => {
    const scoped = new ScopedBudgetTracker();
    scoped.setScopedLimit('group', 'g1', 7.5);
    expect(scoped.getScopedLimit('group', 'g1')).toBe(7.5);
  });
});
