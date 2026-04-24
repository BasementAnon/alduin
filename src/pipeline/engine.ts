import { randomUUID } from 'node:crypto';
import type { AlduinConfig } from '../config/types.js';
import type { ExecutorTask } from '../executor/types.js';
import type { PolicyVerdict } from '../auth/policy.js';
import { ExecutorDispatcher } from '../executor/dispatch.js';
import { TraceLogger } from '../trace/logger.js';
import type { PipelineDefinition, PipelineState } from './types.js';

/**
 * Deterministic pipeline engine.
 * Executes a PipelineDefinition without consuming LLM tokens on "what step is next."
 * The execution order is fully determined by the step graph at definition time.
 *
 * TODO: Execute independent steps (no mutual depends_on) in parallel via
 * dispatcher.dispatchParallel() for a significant throughput improvement on
 * pipelines with branching shapes.
 */
export class PipelineEngine {
  private dispatcher: ExecutorDispatcher;
  private config: AlduinConfig;
  private traceLogger: TraceLogger;

  constructor(
    dispatcher: ExecutorDispatcher,
    config: AlduinConfig,
    traceLogger: TraceLogger
  ) {
    this.dispatcher = dispatcher;
    this.config = config;
    this.traceLogger = traceLogger;
  }

  /**
   * Run a pipeline to completion (or failure / stop_condition).
   *
   * @param definition - The pipeline definition to execute
   * @param initialInput - The user's original request, prepended to the first step
   * @param verdict - Policy verdict to enforce against each step's executor
   */
  async run(definition: PipelineDefinition, initialInput: string, verdict?: PolicyVerdict): Promise<PipelineState> {
    const state: PipelineState = {
      pipeline_id: definition.id,
      current_step: 0,
      iteration: 0,
      step_results: new Map(),
      status: 'running',
      started_at: new Date(),
    };

    const traceId = `pipeline-${definition.id}`;
    this.traceLogger.startTrace(traceId, initialInput);

    const maxIterations = definition.max_iterations ?? 1;

    for (let iter = 0; iter < maxIterations; iter++) {
      state.iteration = iter;

      // Clear results at the start of each new iteration (except the first)
      if (iter > 0) {
        state.step_results = new Map();
      }

      const sortedSteps = this.topologicalSort(definition.steps);
      let pipelineFailed = false;

      for (const step of sortedSteps) {
        state.current_step = step.step_index;

        // Policy enforcement: check if this step's executor is allowed
        if (verdict) {
          if (
            verdict.allowed_executors[0] !== '*' &&
            !verdict.allowed_executors.includes(step.executor)
          ) {
            this.traceLogger.logEvent(traceId, {
              event_type: 'executor_failed',
              data: {
                executor: step.executor,
                error: `Executor "${step.executor}" is not allowed by policy`,
              },
            });
            state.status = 'policy_denied';
            pipelineFailed = true;
            break;
          }
        }

        // Build instruction from template, replacing {step_N_result} placeholders
        let instruction = step.instruction_template;
        for (const [idx, result] of state.step_results) {
          const placeholder = `{step_${idx}_result}`;
          const replacement = result.full_output ?? result.summary;
          instruction = instruction.replaceAll(placeholder, replacement);
        }

        // For the very first step of the first iteration, prepend the initial input
        if (step.step_index === 0 && iter === 0) {
          instruction = `${initialInput}\n\n${instruction}`;
        }

        const executorConfig = this.config.executors[step.executor];
        const task: ExecutorTask = {
          id: randomUUID(),
          executor_name: step.executor,
          instruction,
          max_tokens: executorConfig?.max_tokens ?? 4000,
          timeout_ms: 60000,
          tools: executorConfig?.tools ?? [],
          return_format: step.output_type === 'file_ref' ? 'file_ref' : 'full',
          metadata: {
            pipeline_id: definition.id,
            step_index: step.step_index,
          },
          policy_verdict: verdict,
        };

        this.traceLogger.logEvent(traceId, {
          event_type: 'executor_started',
          data: { executor: step.executor, model: executorConfig?.model },
        });

        const result = await this.dispatcher.dispatch(task);
        state.step_results.set(step.step_index, result);

        if (result.status === 'failed' || result.status === 'timeout' || result.status === 'policy_denied') {
          this.traceLogger.logEvent(traceId, {
            event_type: 'executor_failed',
            data: {
              executor: step.executor,
              error: result.error?.message,
            },
          });
          state.status = 'failed';
          pipelineFailed = true;
          break;
        }

        this.traceLogger.logEvent(traceId, {
          event_type: 'executor_completed',
          data: {
            executor: step.executor,
            model: executorConfig?.model,
            tokens_in: result.usage.input_tokens,
            tokens_out: result.usage.output_tokens,
            cost_usd: result.usage.cost_usd,
            latency_ms: result.usage.latency_ms,
          },
        });
      }

      if (pipelineFailed) break;

      // Check stop condition
      if (definition.stop_condition) {
        if (this.evaluateStopCondition(definition.stop_condition, state.step_results)) {
          state.status = 'completed';
          break;
        }
        // Condition not met — loop again if iterations remain
      } else {
        // No stop condition → single pass
        state.status = 'completed';
        break;
      }

      // Last iteration and condition never met
      if (iter === maxIterations - 1) {
        state.status = 'completed';
      }
    }

    state.completed_at = new Date();
    this.traceLogger.completeTrace(traceId);
    return state;
  }

  /**
   * Topologically sort steps so each step runs after all its dependencies.
   * Simple approach: iterate indices 0..N in declaration order, which is valid
   * when steps are defined with increasing step_index values.
   */
  private topologicalSort(steps: PipelineDefinition['steps']): PipelineDefinition['steps'] {
    return [...steps].sort((a, b) => a.step_index - b.step_index);
  }

  /**
   * Evaluate a stop condition expression against step results.
   * Format: "step_N.keyword" — returns true when the keyword appears in step N's output.
   * Example: "step_1.pass" → checks if step 1's output contains the word "pass".
   */
  private evaluateStopCondition(
    condition: string,
    stepResults: Map<number, import('../executor/types.js').ExecutorResult>
  ): boolean {
    const match = condition.match(/^step_(\d+)\.(\w+)$/);
    if (!match) return false;

    const stepIndex = parseInt(match[1]!, 10);
    const keyword = match[2]!.toLowerCase();

    const result = stepResults.get(stepIndex);
    if (!result) return false;

    const output = (result.full_output ?? result.summary).toLowerCase();
    return output.includes(keyword);
  }
}
