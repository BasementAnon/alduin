import { ProviderRegistry } from '../providers/registry.js';
import { BudgetGuard, BudgetTracker } from '../tokens/budget.js';
import { TokenCounter } from '../tokens/counter.js';
import { ResultSummarizer } from './summarizer.js';
import { buildExecutorContext } from './sandbox.js';
import type { ExecutorTask, ExecutorResult } from './types.js';
import type { AlduinConfig } from '../config/types.js';
import type { LLMCompletionRequest, LLMCompletionResponse, LLMError } from '../types/llm.js';
import type { Result } from '../types/result.js';
import type { RecursionGuard } from '../orchestrator/recursion.js';
import { TraceLogger } from '../trace/logger.js';
import { writeChildSystemPrompt } from '../orchestrator/prompts.js';
import { raceWithTimeout } from '../util/timeout.js';

const MAX_CONCURRENCY = 5;

/**
 * Factory function type for creating child OrchestratorLoop instances.
 * Injected to avoid a circular import between dispatch.ts and loop.ts.
 */
export type ChildOrchestratorFactory = (
  config: AlduinConfig,
  providerRegistry: ProviderRegistry,
  budgetGuard: BudgetGuard,
  tokenCounter: TokenCounter,
  traceLogger: TraceLogger,
) => {
  processMessage: (
    instruction: string,
    history: [],
    verdict: ExecutorTask['policy_verdict'],
    orchestration: ExecutorTask['orchestration'],
    guard?: RecursionGuard,
  ) => Promise<{ response: string; trace: import('../trace/types.js').TaskTrace }>;
};

/**
 * Dispatches executor tasks to the correct provider and manages
 * budget checks, timeouts, and result summarization.
 *
 * When a task has orchestration.allow_sub_orchestration set and
 * the recursion guard approves, the dispatcher spawns a child
 * OrchestratorLoop instead of making a direct LLM call.
 */
export class ExecutorDispatcher {
  private providerRegistry: ProviderRegistry;
  private config: AlduinConfig;
  private budgetGuard: BudgetGuard;
  private summarizer: ResultSummarizer;
  private tokenCounter: TokenCounter;
  private traceLogger: TraceLogger;
  private childFactory: ChildOrchestratorFactory | null;

  constructor(
    providerRegistry: ProviderRegistry,
    config: AlduinConfig,
    budgetGuard: BudgetGuard,
    summarizer: ResultSummarizer,
    tokenCounter: TokenCounter,
    traceLogger?: TraceLogger,
    childFactory?: ChildOrchestratorFactory,
  ) {
    this.providerRegistry = providerRegistry;
    this.config = config;
    this.budgetGuard = budgetGuard;
    this.summarizer = summarizer;
    this.tokenCounter = tokenCounter;
    this.traceLogger = traceLogger ?? new TraceLogger();
    this.childFactory = childFactory ?? null;
  }

  /**
   * Dispatch a single executor task.
   * If the task requests sub-orchestration and the guard allows it,
   * a child OrchestratorLoop is spawned. Otherwise, resolves the
   * provider, checks budget, calls the LLM with a timeout, and
   * summarizes the result if requested.
   */
  async dispatch(task: ExecutorTask, recursionGuard?: RecursionGuard): Promise<ExecutorResult> {
    // ── Sub-orchestration path ───────────────────────────────────────────
    if (task.orchestration?.allow_sub_orchestration && recursionGuard) {
      return this.dispatchSubOrchestration(task, recursionGuard);
    }

    // ── Standard executor path ───────────────────────────────────────────
    return this.dispatchDirect(task);
  }

  /**
   * Dispatch multiple independent tasks concurrently with a concurrency limit of 5.
   */
  async dispatchParallel(tasks: ExecutorTask[], recursionGuard?: RecursionGuard): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = new Array(tasks.length);
    let nextIndex = 0;
    let inFlight = 0;

    return new Promise((resolve) => {
      const runNext = (): void => {
        while (inFlight < MAX_CONCURRENCY && nextIndex < tasks.length) {
          const idx = nextIndex++;
          inFlight++;
          this.dispatch(tasks[idx]!, recursionGuard)
            .catch((error: unknown) =>
              this.failedResult(tasks[idx]!, 'failed', {
                type: 'dispatch_error',
                message: error instanceof Error ? error.message : String(error),
              })
            )
            .then((result) => {
              results[idx] = result;
              inFlight--;
              if (nextIndex >= tasks.length && inFlight === 0) {
                resolve(results);
              } else {
                runNext();
              }
            });
        }
      };

      if (tasks.length === 0) {
        resolve(results);
        return;
      }
      runNext();
    });
  }

  // ── Sub-orchestration dispatch ─────────────────────────────────────────

  private async dispatchSubOrchestration(
    task: ExecutorTask,
    guard: RecursionGuard,
  ): Promise<ExecutorResult> {
    const orch = task.orchestration!;
    const executorConfig = this.config.executors[task.executor_name];
    const childModel = executorConfig?.model ?? orch.parent_model;

    // Run pre-check
    const verdict = guard.preCheck({
      parentModel: orch.parent_model,
      childModel,
      instruction: task.instruction + (task.input_data ?? ''),
      parentDepth: orch.parent_depth,
      maxDepth: orch.max_depth,
      parentBudgetRemaining: orch.parent_budget_remaining_usd,
      allowSameModelRecursion: orch.allow_same_model_recursion ?? false,
      verdict: task.policy_verdict,
    });

    if (!verdict.allowed) {
      return this.failedResult(task, verdict.reason, {
        type: verdict.reason,
        message: verdict.message,
      });
    }

    // Register edge before dispatching
    guard.registerEdge(
      orch.parent_model,
      childModel,
      task.instruction + (task.input_data ?? ''),
    );

    // Bail if no child factory is available
    if (!this.childFactory) {
      return this.failedResult(task, 'failed', {
        type: 'config_error',
        message: 'Sub-orchestration requested but no child orchestrator factory is configured.',
      });
    }

    const startTime = Date.now();

    // Create a child budget guard with the parent's remaining budget as ceiling
    const childBudgetTracker = new BudgetTracker({
      daily_limit_usd: orch.parent_budget_remaining_usd,
      per_task_limit_usd: orch.parent_budget_remaining_usd,
      warning_threshold: 0.8,
    });
    const childBudgetGuard = new BudgetGuard(childBudgetTracker);
    const childTraceLogger = new TraceLogger();

    // Build child system prompt
    const childSystemPrompt = writeChildSystemPrompt(
      orch.parent_model,
      childModel,
      task.instruction + (task.input_data ? `\n\nInput:\n${task.input_data}` : ''),
      'deterministic',
    );

    // Create child orchestrator
    const childLoop = this.childFactory(
      this.config,
      this.providerRegistry,
      childBudgetGuard,
      this.tokenCounter,
      childTraceLogger,
    );

    // Prepare child orchestration context
    const childOrchestration = {
      allow_sub_orchestration: false, // Children don't sub-orchestrate by default
      max_depth: orch.max_depth,
      parent_task_id: task.id,
      parent_depth: orch.parent_depth + 1,
      parent_budget_remaining_usd: orch.parent_budget_remaining_usd,
      parent_timeout_remaining_ms: orch.parent_timeout_remaining_ms,
      parent_model: childModel,
    };

    try {
      // Execute child orchestrator with timeout
      const childPromise = childLoop.processMessage(
        childSystemPrompt,
        [],
        task.policy_verdict,
        childOrchestration,
        guard,
      );

      const { response, trace: childTrace } = await raceWithTimeout(
        childPromise,
        orch.parent_timeout_remaining_ms,
        `Child orchestration timed out after ${orch.parent_timeout_remaining_ms}ms`,
      );

      const latency_ms = Date.now() - startTime;

      // Roll up child cost to parent
      this.budgetGuard.postRecord(
        task.id,
        'sub-orchestration',
        { input_tokens: childTrace.total_tokens.input, output_tokens: childTrace.total_tokens.output },
        childTrace.total_cost_usd,
      );

      return {
        task_id: task.id,
        executor_name: task.executor_name,
        status: 'complete',
        summary: response,
        usage: {
          input_tokens: childTrace.total_tokens.input,
          output_tokens: childTrace.total_tokens.output,
          cost_usd: childTrace.total_cost_usd,
          latency_ms,
        },
        sub_orchestration: {
          child_task_id: childTrace.task_id,
          child_steps_executed: childTrace.events.filter(
            (e) => e.event_type === 'executor_completed' || e.event_type === 'executor_failed',
          ).length,
          child_cost_usd: childTrace.total_cost_usd,
          child_latency_ms: latency_ms,
          child_depth: orch.parent_depth + 1,
          child_model: childModel,
        },
      };
    } catch (err) {
      const latency_ms = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);

      // Still roll up any partial cost from the child
      const partialCost = childBudgetGuard.currentSpend();
      if (partialCost > 0) {
        this.budgetGuard.postRecord(
          task.id,
          'sub-orchestration',
          { input_tokens: 0, output_tokens: 0 },
          partialCost,
        );
      }

      const status = message.includes('timed out') ? 'timeout' as const : 'failed' as const;
      return {
        task_id: task.id,
        executor_name: task.executor_name,
        status,
        summary: `Sub-orchestration failed: ${message}`,
        error: { type: status, message },
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: partialCost, latency_ms },
      };
    }
  }

  // ── Standard direct dispatch ───────────────────────────────────────────

  private async dispatchDirect(task: ExecutorTask): Promise<ExecutorResult> {
    const executorConfig = this.config.executors[task.executor_name];
    if (!executorConfig) {
      return this.failedResult(task, 'failed', {
        type: 'config_error',
        message: `Unknown executor: ${task.executor_name}`,
      });
    }

    // Policy enforcement — check allowed_executors and cost_ceiling_usd
    const verdict = task.policy_verdict;
    if (verdict) {
      if (
        verdict.allowed_executors[0] !== '*' &&
        !verdict.allowed_executors.includes(task.executor_name)
      ) {
        return this.failedResult(task, 'policy_denied', {
          type: 'policy_denied',
          message: `Executor "${task.executor_name}" is not allowed by policy`,
        });
      }
    }

    const modelString = executorConfig.model;
    const provider = this.providerRegistry.resolveProvider(modelString);
    if (!provider) {
      return this.failedResult(task, 'failed', {
        type: 'provider_error',
        message: `No provider registered for model: ${modelString}`,
      });
    }

    // Budget pre-check
    const budgetCheck = this.budgetGuard.preCheck(modelString);
    if (!budgetCheck.ok) {
      return this.failedResult(task, 'budget_exceeded', {
        type: 'budget_exceeded',
        message: `Budget exceeded for ${modelString}: spent $${budgetCheck.error.spent.toFixed(2)} of $${budgetCheck.error.limit.toFixed(2)} limit`,
      });
    }

    // Per-turn cost ceiling from policy verdict
    if (verdict && verdict.cost_ceiling_usd > 0) {
      const estimatedInputTokens = this.tokenCounter.countTokens(
        task.instruction + (task.input_data ?? ''),
        modelString
      );
      const estimatedCost = provider.estimateCost(modelString, {
        input_tokens: estimatedInputTokens,
        output_tokens: task.max_tokens,
      });
      if (estimatedCost > verdict.cost_ceiling_usd) {
        return this.failedResult(task, 'policy_denied', {
          type: 'cost_ceiling_exceeded',
          message: `Estimated cost $${estimatedCost.toFixed(4)} exceeds policy ceiling $${verdict.cost_ceiling_usd.toFixed(2)}`,
        });
      }
    }

    const messages = buildExecutorContext(task);
    const modelName = this.providerRegistry.resolveModelName(modelString);

    const request: LLMCompletionRequest = {
      model: modelName,
      messages,
      max_tokens: task.max_tokens || executorConfig.max_tokens,
    };

    const startTime = Date.now();
    let result: Result<LLMCompletionResponse, LLMError>;

    try {
      result = await raceWithTimeout(
        provider.complete(request),
        task.timeout_ms,
        `Timeout after ${task.timeout_ms}ms`,
      );
    } catch {
      const latency_ms = Date.now() - startTime;
      return {
        task_id: task.id,
        executor_name: task.executor_name,
        status: 'timeout',
        summary: `Task timed out after ${latency_ms}ms`,
        error: { type: 'timeout', message: `Executor timed out after ${task.timeout_ms}ms` },
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms },
      };
    }

    const latency_ms = Date.now() - startTime;

    if (!result.ok) {
      const status = result.error.type === 'timeout' ? 'timeout' : 'failed';
      return {
        task_id: task.id,
        executor_name: task.executor_name,
        status,
        summary: `Executor failed: ${result.error.message}`,
        error: { type: result.error.type, message: result.error.message },
        usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms },
      };
    }

    const response = result.value;
    const cost_usd = provider.estimateCost(modelName, response.usage);

    // Record usage for budget tracking
    this.budgetGuard.postRecord(task.id, modelString, response.usage, cost_usd);

    // Summarize if needed
    let summary = response.content;
    if (task.return_format === 'summary') {
      summary = await this.summarizer.summarize(task.executor_name, response.content);
    }

    return {
      task_id: task.id,
      executor_name: task.executor_name,
      status: 'complete',
      summary,
      ...(task.return_format === 'full' ? { full_output: response.content } : {}),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cost_usd,
        latency_ms,
      },
    };
  }

  private failedResult(
    task: ExecutorTask,
    status: ExecutorResult['status'],
    error: { type: string; message: string }
  ): ExecutorResult {
    return {
      task_id: task.id,
      executor_name: task.executor_name,
      status,
      summary: error.message,
      error,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 0 },
    };
  }
}
