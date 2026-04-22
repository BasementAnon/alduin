import { readFileSync, writeFileSync } from 'fs';
import type { BudgetConfig } from '../config/types.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

/** Per-model usage snapshot */
interface ModelUsage {
  tokens: number;
  cost: number;
}

/** State that can be persisted to / restored from disk */
interface BudgetState {
  date: string; // UTC date string YYYY-MM-DD
  perModel: Record<string, ModelUsage>;
}

/** Error type emitted when a budget limit is exceeded */
export interface BudgetExceeded {
  model: string;
  limit: number;
  spent: number;
}

/** Returns today's UTC date as YYYY-MM-DD */
function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tracks per-model token usage and cost against configured daily limits.
 * State is reset automatically when the UTC date changes.
 */
export class BudgetTracker {
  private config: BudgetConfig;
  private perModel: Map<string, ModelUsage> = new Map();
  private lastResetDate: string;

  constructor(config: BudgetConfig, initialDate?: string) {
    this.config = config;
    this.lastResetDate = initialDate ?? utcDateString();
  }

  /**
   * Record usage from a completed LLM call.
   * Automatically resets state if the UTC date has changed.
   */
  trackUsage(
    _taskId: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number },
    cost_usd: number
  ): void {
    this.resetIfNewDay();
    const current = this.perModel.get(model) ?? { tokens: 0, cost: 0 };
    this.perModel.set(model, {
      tokens: current.tokens + usage.input_tokens + usage.output_tokens,
      cost: current.cost + cost_usd,
    });
  }

  /**
   * Check whether a model is within budget before making an LLM call.
   *
   * @returns `{ allowed, remaining_usd, warning }`
   * - `warning` is true when total spend ≥ (daily_limit × warning_threshold)
   * - `allowed` is false when model's spend ≥ per_model_limit OR total ≥ daily_limit
   */
  checkBudget(model: string): {
    allowed: boolean;
    remaining_usd: number;
    warning: boolean;
  } {
    this.resetIfNewDay();

    const totalSpent = this.totalCost();
    const remaining_usd = Math.max(0, this.config.daily_limit_usd - totalSpent);
    const warning =
      totalSpent >= this.config.daily_limit_usd * this.config.warning_threshold;

    // Hard stop: daily total exceeded
    if (totalSpent >= this.config.daily_limit_usd) {
      return { allowed: false, remaining_usd: 0, warning: true };
    }

    // Hard stop: per-model limit exceeded
    const modelLimit = this.config.per_model_limits?.[model];
    if (modelLimit !== undefined) {
      const modelSpent = this.perModel.get(model)?.cost ?? 0;
      if (modelSpent >= modelLimit) {
        return { allowed: false, remaining_usd, warning };
      }
    }

    return { allowed: true, remaining_usd, warning };
  }

  /** Summarize today's spending across all models */
  getDailySummary(): {
    per_model: Map<string, ModelUsage>;
    total_cost: number;
    budget_remaining: number;
  } {
    this.resetIfNewDay();
    const total_cost = this.totalCost();
    return {
      per_model: new Map(this.perModel),
      total_cost,
      budget_remaining: Math.max(0, this.config.daily_limit_usd - total_cost),
    };
  }

  /** Update the daily spending limit at runtime. */
  setDailyLimit(usd: number): void {
    this.config = { ...this.config, daily_limit_usd: usd };
  }

  /** Update the warning threshold (0–1) at runtime. */
  setWarningThreshold(threshold: number): void {
    this.config = { ...this.config, warning_threshold: threshold };
  }

  /** Set or update a per-model spending limit at runtime. */
  setPerModelLimit(model: string, usd: number): void {
    const limits = { ...(this.config.per_model_limits ?? {}), [model]: usd };
    this.config = { ...this.config, per_model_limits: limits };
  }

  /** Reset state if the UTC date has rolled over */
  resetIfNewDay(): void {
    const today = utcDateString();
    if (today !== this.lastResetDate) {
      this.perModel.clear();
      this.lastResetDate = today;
    }
  }

  /** Persist current state to a JSON file */
  persist(filePath: string): void {
    const state: BudgetState = {
      date: this.lastResetDate,
      perModel: Object.fromEntries(this.perModel),
    };
    writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Restore a previously persisted BudgetTracker from a JSON file.
   * If the persisted date doesn't match today, starts fresh.
   */
  static restore(filePath: string, config: BudgetConfig): BudgetTracker {
    const raw = readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as BudgetState;
    const tracker = new BudgetTracker(config, state.date);

    // Only restore if the date is still today
    if (state.date === utcDateString()) {
      for (const [model, usage] of Object.entries(state.perModel)) {
        tracker.perModel.set(model, usage);
      }
    }

    return tracker;
  }

  private totalCost(): number {
    let total = 0;
    for (const usage of this.perModel.values()) {
      total += usage.cost;
    }
    return total;
  }
}

/**
 * Pre/post guard around LLM calls.
 * Wraps BudgetTracker with Result-typed pre-check and simple post-record.
 */
export class BudgetGuard {
  private tracker: BudgetTracker;

  constructor(tracker: BudgetTracker) {
    this.tracker = tracker;
  }

  /**
   * Check budget before making a call.
   * Returns `ok({ warning })` if allowed, `err(BudgetExceeded)` if the limit is hit.
   */
  preCheck(model: string): Result<{ warning: boolean }, BudgetExceeded> {
    const { allowed, remaining_usd, warning } = this.tracker.checkBudget(model);
    if (!allowed) {
      const summary = this.tracker.getDailySummary();
      const spent = summary.per_model.get(model)?.cost ?? summary.total_cost;
      const limit =
        this.tracker['config'].per_model_limits?.[model] ??
        this.tracker['config'].daily_limit_usd;
      return err({ model, limit, spent });
    }
    void remaining_usd; // acknowledged but not returned in the ok branch
    return ok({ warning });
  }

  /** Record usage after a successful LLM call */
  postRecord(
    taskId: string,
    model: string,
    usage: { input_tokens: number; output_tokens: number },
    cost: number
  ): void {
    this.tracker.trackUsage(taskId, model, usage, cost);
  }

  /** Current total spend across all models today (USD). */
  currentSpend(): number {
    return this.tracker.getDailySummary().total_cost;
  }

  /** Remaining budget (USD). */
  budgetRemaining(): number {
    return this.tracker.getDailySummary().budget_remaining;
  }
}

// ── Scoped budget tracking (per-user, per-group) ──────────────────────────────

export type BudgetScope = 'user' | 'group';

interface ScopedSpend {
  cost: number;
  limit: number; // 0 = no limit
}

/**
 * Tracks spending at user and group scopes in addition to the global budget.
 * Reset daily alongside the global BudgetTracker.
 *
 * Enforcement: the executor dispatcher calls `checkScoped()` before each call.
 * This is additive — the global BudgetTracker's limits are checked first.
 */
export class ScopedBudgetTracker {
  private perUser = new Map<string, ScopedSpend>();
  private perGroup = new Map<string, ScopedSpend>();
  private lastResetDate: string;

  constructor() {
    this.lastResetDate = utcDateString();
  }

  /** Track cost for a user and optionally a group */
  trackScoped(userId: string, groupId: string | undefined, cost: number): void {
    this.resetIfNewDay();

    const user = this.perUser.get(userId) ?? { cost: 0, limit: 0 };
    user.cost += cost;
    this.perUser.set(userId, user);

    if (groupId) {
      const group = this.perGroup.get(groupId) ?? { cost: 0, limit: 0 };
      group.cost += cost;
      this.perGroup.set(groupId, group);
    }
  }

  /**
   * Check scoped budget before a call.
   * Returns { allowed, denied_scope } — denied_scope is set when a limit is hit.
   */
  checkScoped(
    userId: string,
    groupId?: string
  ): { allowed: boolean; denied_scope?: string } {
    this.resetIfNewDay();

    const user = this.perUser.get(userId);
    if (user && user.limit > 0 && user.cost >= user.limit) {
      return { allowed: false, denied_scope: `user:${userId}` };
    }

    if (groupId) {
      const group = this.perGroup.get(groupId);
      if (group && group.limit > 0 && group.cost >= group.limit) {
        return { allowed: false, denied_scope: `group:${groupId}` };
      }
    }

    return { allowed: true };
  }

  /** Set a daily limit for a user or group */
  setScopedLimit(scope: BudgetScope, id: string, limitUsd: number): void {
    const map = scope === 'user' ? this.perUser : this.perGroup;
    const entry = map.get(id) ?? { cost: 0, limit: 0 };
    entry.limit = limitUsd;
    map.set(id, entry);
  }

  /** Get current spend for a scope */
  getScopedSpend(scope: BudgetScope, id: string): number {
    this.resetIfNewDay();
    const map = scope === 'user' ? this.perUser : this.perGroup;
    return map.get(id)?.cost ?? 0;
  }

  /** Get the daily limit for a scope (0 = no limit) */
  getScopedLimit(scope: BudgetScope, id: string): number {
    const map = scope === 'user' ? this.perUser : this.perGroup;
    return map.get(id)?.limit ?? 0;
  }

  private resetIfNewDay(): void {
    const today = utcDateString();
    if (today !== this.lastResetDate) {
      // Preserve limits but reset spend
      for (const entry of this.perUser.values()) entry.cost = 0;
      for (const entry of this.perGroup.values()) entry.cost = 0;
      this.lastResetDate = today;
    }
  }
}
