import { randomUUID } from 'node:crypto';
import type { AlduinConfig } from '../config/types.js';
import type { ConversationTurn } from '../types/llm.js';
import type { TaskTrace } from '../trace/types.js';
import type { ExecutorTask } from '../executor/types.js';
import type { PolicyVerdict } from '../auth/policy.js';
import { TraceLogger } from '../trace/logger.js';
import { ExecutorDispatcher } from '../executor/dispatch.js';
import { TokenCounter } from '../tokens/counter.js';
import { OrchestratorLoop } from '../orchestrator/loop.js';
import { MessageClassifier } from './classifier.js';

/**
 * Top-level routing entry point.
 * Classifies messages before the orchestrator sees them, so cheap single-domain
 * tasks can skip full orchestrator planning entirely.
 *
 * Cost model comparison:
 *   Classifier-routed: classifier ($0.0001) + executor ($0.001) ≈ $0.0011
 *   Fully orchestrated: classifier + orchestrator + executor + synthesis ≈ $0.05
 */
export class Router {
  private config: AlduinConfig;
  private classifier: MessageClassifier;
  private orchestratorLoop: OrchestratorLoop;
  private dispatcher: ExecutorDispatcher;
  private traceLogger: TraceLogger;
  private tokenCounter: TokenCounter;

  constructor(
    config: AlduinConfig,
    classifier: MessageClassifier,
    orchestratorLoop: OrchestratorLoop,
    dispatcher: ExecutorDispatcher,
    traceLogger: TraceLogger,
    tokenCounter: TokenCounter
  ) {
    this.config = config;
    this.classifier = classifier;
    this.orchestratorLoop = orchestratorLoop;
    this.dispatcher = dispatcher;
    this.traceLogger = traceLogger;
    this.tokenCounter = tokenCounter;
  }

  /**
   * Route a user message to the cheapest capable handler.
   *
   * Decision tree:
   * 1. Pre-classifier disabled → full orchestrator
   * 2. Classifier result: needs_orchestrator → full orchestrator
   * 3. High-confidence single-domain with a known executor → direct dispatch
   * 4. Everything else → full orchestrator
   */
  async route(
    userMessage: string,
    conversationHistory: ConversationTurn[],
    verdict: PolicyVerdict
  ): Promise<{ response: string; trace: TaskTrace }> {
    // Fast path: classifier disabled in config
    if (!this.config.routing.pre_classifier) {
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    // Classify — errors silently fall through to orchestrator
    const classifyResult = await this.classifier.classify(userMessage);
    if (!classifyResult.ok) {
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    const classification = classifyResult.value;

    // Orchestrator required: complex, multi-step, or low-confidence
    if (classification.needs_orchestrator) {
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    // Confidence below threshold: not confident enough to skip planning
    if (classification.confidence < this.config.routing.complexity_threshold) {
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    // No suggested executor (e.g. pure conversation) → orchestrator handles it efficiently
    if (!classification.suggested_executor) {
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    // Direct dispatch — skip the orchestrator entirely
    return this.directDispatch(userMessage, classification.suggested_executor, verdict, conversationHistory);
  }

  /**
   * Dispatch directly to an executor, bypassing orchestrator planning.
   * Enforces policy-based executor allowlist before dispatch.
   * On policy denial, returns a policy-denied response without falling back.
   * On executor failure, falls back to the orchestrator loop for recovery.
   */
  private async directDispatch(
    userMessage: string,
    executorName: string,
    verdict: PolicyVerdict,
    conversationHistory: ConversationTurn[] = []
  ): Promise<{ response: string; trace: TaskTrace }> {
    const taskId = randomUUID();
    this.traceLogger.startTrace(taskId, userMessage);

    const executorConfig = this.config.executors[executorName];
    // Guard: executor must exist (classifier validation should ensure this)
    if (!executorConfig) {
      this.traceLogger.completeTrace(taskId);
      return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
    }

    // Policy enforcement: check allowed_executors before dispatch
    if (
      verdict.allowed_executors?.length > 0 &&
      verdict.allowed_executors[0] !== '*' &&
      !verdict.allowed_executors.includes(executorName)
    ) {
      this.traceLogger.logEvent(taskId, {
        event_type: 'executor_failed',
        data: {
          executor: executorName,
          error: `Executor "${executorName}" is not allowed by policy`,
        },
      });
      const trace = this.traceLogger.completeTrace(taskId)!;
      return {
        response: `Policy violation: executor "${executorName}" is not allowed in this context.`,
        trace,
      };
    }

    const task: ExecutorTask = {
      id: taskId,
      executor_name: executorName,
      instruction: userMessage,
      max_tokens: executorConfig.max_tokens,
      timeout_ms: 60000,
      tools: executorConfig.tools,
      return_format: 'full',
      metadata: { parent_task_id: taskId },
      policy_verdict: verdict,
    };

    this.traceLogger.logEvent(taskId, {
      event_type: 'executor_started',
      data: {
        executor: executorName,
        model: executorConfig.model,
      },
    });

    const result = await this.dispatcher.dispatch(task);

    if (result.status === 'complete') {
      this.traceLogger.logEvent(taskId, {
        event_type: 'executor_completed',
        data: {
          executor: executorName,
          model: executorConfig.model,
          tokens_in: result.usage.input_tokens,
          tokens_out: result.usage.output_tokens,
          cost_usd: result.usage.cost_usd,
          latency_ms: result.usage.latency_ms,
          result_summary: result.summary,
        },
      });

      const trace = this.traceLogger.completeTrace(taskId)!;
      return {
        response: result.full_output ?? result.summary,
        trace,
      };
    }

    // Executor failed — log and fall back to orchestrator for recovery
    this.traceLogger.logEvent(taskId, {
      event_type: 'executor_failed',
      data: {
        executor: executorName,
        error: result.error?.message,
      },
    });
    this.traceLogger.completeTrace(taskId);

    return this.orchestratorLoop.processMessage(userMessage, conversationHistory, verdict);
  }
}
