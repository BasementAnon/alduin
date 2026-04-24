import { BudgetTracker } from '../tokens/budget.js';
import { TraceLogger } from '../trace/logger.js';

/** Per-dimension cost/token/task breakdown */
export interface DimensionStats {
  cost: number;
  tokens: number;
  tasks: number;
}

/** Daily usage report aggregated from budget tracker and trace data */
export interface DailyReport {
  /** YYYY-MM-DD */
  date: string;
  total_cost_usd: number;
  total_tokens: { input: number; output: number };
  total_tasks: number;
  by_model: Record<string, DimensionStats>;
  by_executor: Record<string, DimensionStats>;
  budget_remaining_usd: number;
  budget_pct_used: number;
}

/**
 * Aggregates budget tracker data and trace events into reports.
 */
export class UsageReporter {
  private budgetTracker: BudgetTracker;
  private traceLogger: TraceLogger;

  constructor(budgetTracker: BudgetTracker, traceLogger: TraceLogger) {
    this.budgetTracker = budgetTracker;
    this.traceLogger = traceLogger;
  }

  /** Build the full daily usage report */
  getDailyReport(): DailyReport {
    const summary = this.budgetTracker.getDailySummary();
    const date = new Date().toISOString().slice(0, 10);

    // Build per-model breakdown from budget tracker
    const by_model: Record<string, DimensionStats> = {};
    for (const [model, usage] of summary.per_model) {
      by_model[model] = { cost: usage.cost, tokens: usage.tokens, tasks: 0 };
    }

    // Supplement with per-executor and per-task counts from traces
    const by_executor: Record<string, DimensionStats> = {};
    let total_input = 0;
    let total_output = 0;
    let total_tasks = 0;

    // Walk completed traces to build per-executor breakdown
    for (const trace of this.traceLogger.getAllTraces()) {
      if (!trace.completed_at) continue;
      total_tasks++;

      for (const event of trace.events) {
        if (event.event_type !== 'executor_completed') continue;

        const executor = event.data.executor ?? 'unknown';
        const tokensIn = event.data.tokens_in ?? 0;
        const tokensOut = event.data.tokens_out ?? 0;
        const cost = event.data.cost_usd ?? 0;

        total_input += tokensIn;
        total_output += tokensOut;

        if (!by_executor[executor]) {
          by_executor[executor] = { cost: 0, tokens: 0, tasks: 0 };
        }
        by_executor[executor].cost += cost;
        by_executor[executor].tokens += tokensIn + tokensOut;
        by_executor[executor].tasks++;

        // Increment task count on the by_model entry
        const model = event.data.model;
        if (model && by_model[model]) {
          by_model[model].tasks++;
        }
      }
    }

    const daily_limit = this.budgetTracker.getDailyLimitUsd();
    const budget_pct_used =
      daily_limit > 0 ? (summary.total_cost / daily_limit) * 100 : 0;

    return {
      date,
      total_cost_usd: summary.total_cost,
      total_tokens: { input: total_input, output: total_output },
      total_tasks,
      by_model,
      by_executor,
      budget_remaining_usd: summary.budget_remaining,
      budget_pct_used,
    };
  }

  /**
   * Return a one-line trace summary for a task, or null if not found.
   */
  getTaskReport(taskId: string): string | null {
    const trace = this.traceLogger.getTrace(taskId);
    if (!trace) return null;
    return this.traceLogger.formatTraceSummary(taskId);
  }
}
