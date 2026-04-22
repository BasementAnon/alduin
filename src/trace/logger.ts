import type { TaskTrace, TraceEvent, TraceEventData, TraceEventType } from './types.js';

/**
 * Per-task trace logger.
 * Every LLM call is traced: model, tokens in/out, cost, latency, task ID.
 */
export class TraceLogger {
  private traces: Map<string, TaskTrace> = new Map();

  /** Create and store a new trace for a task */
  startTrace(taskId: string, userMessage: string): TaskTrace {
    const trace: TaskTrace = {
      task_id: taskId,
      user_message: userMessage,
      started_at: new Date(),
      events: [],
      total_cost_usd: 0,
      total_tokens: { input: 0, output: 0 },
      total_latency_ms: 0,
    };
    this.traces.set(taskId, trace);
    return trace;
  }

  /** Add a timestamped event to a trace, updating running totals */
  logEvent(
    taskId: string,
    event: { event_type: TraceEventType; data: TraceEventData }
  ): void {
    const trace = this.traces.get(taskId);
    if (!trace) return;

    const fullEvent: TraceEvent = {
      task_id: taskId,
      timestamp: new Date(),
      event_type: event.event_type,
      data: event.data,
    };
    trace.events.push(fullEvent);

    // Update running totals from event data
    if (event.data.cost_usd !== undefined) {
      trace.total_cost_usd += event.data.cost_usd;
    }
    if (event.data.tokens_in !== undefined) {
      trace.total_tokens.input += event.data.tokens_in;
    }
    if (event.data.tokens_out !== undefined) {
      trace.total_tokens.output += event.data.tokens_out;
    }
    if (event.data.latency_ms !== undefined) {
      trace.total_latency_ms += event.data.latency_ms;
    }
  }

  /** Mark a trace as complete and return it */
  completeTrace(taskId: string): TaskTrace | undefined {
    const trace = this.traces.get(taskId);
    if (!trace) return undefined;
    trace.completed_at = new Date();
    return trace;
  }

  /** Retrieve a trace by ID */
  getTrace(taskId: string): TaskTrace | undefined {
    return this.traces.get(taskId);
  }

  /**
   * Format a one-line summary of a trace's executor events.
   *
   * Example output:
   * "code(3.1s,$0.02) → research(4.7s,$0.08) | Total: $0.10 | 12,436 tokens | 7.8s"
   */
  formatTraceSummary(taskId: string): string {
    const trace = this.traces.get(taskId);
    if (!trace) return `[trace ${taskId} not found]`;

    const executorEvents = trace.events.filter(
      (e) => e.event_type === 'executor_completed' || e.event_type === 'synthesis_completed'
    );

    const parts = executorEvents.map((e) => {
      const name = e.data.executor ?? 'synthesis';
      const latency = ((e.data.latency_ms ?? 0) / 1000).toFixed(1);
      const cost = (e.data.cost_usd ?? 0).toFixed(2);
      return `${name}(${latency}s,$${cost})`;
    });

    const totalTokens = trace.total_tokens.input + trace.total_tokens.output;
    const formattedTokens = totalTokens.toLocaleString('en-US');
    const totalLatency = (trace.total_latency_ms / 1000).toFixed(1);
    const totalCost = trace.total_cost_usd.toFixed(2);

    const stepsPart = parts.length > 0 ? parts.join(' → ') : 'no steps';
    return `${stepsPart} | Total: $${totalCost} | ${formattedTokens} tokens | ${totalLatency}s`;
  }

  /**
   * Format a tree-shaped trace summary for turns that involved recursion.
   * Non-recursive turns fall back to the flat formatTraceSummary() output.
   *
   * Example output:
   *   ▸ plan (sonnet, $0.004, 1.1s)
   *     ├─ step 1: draft via ollama/qwen (depth=1, $0, 3.2s)
   *     │   └─ sub-step: critique via sonnet (depth=2, $0.002, 0.8s)
   *     └─ step 2: synth via sonnet ($0.006, 1.0s)
   *   Σ $0.012 · 6.1s · 4 calls · depth max 2
   */
  formatTraceTree(taskId: string): string {
    const trace = this.traces.get(taskId);
    if (!trace) return `[trace ${taskId} not found]`;

    const hasRecursion = trace.events.some(
      (e) =>
        e.event_type === 'child_orchestration_started' ||
        e.event_type === 'child_orchestration_completed' ||
        e.event_type === 'child_orchestration_failed'
    );

    // Fall back to flat summary if no recursion occurred
    if (!hasRecursion) {
      return this.formatTraceSummary(taskId);
    }

    const lines: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    let callCount = 0;

    for (const event of trace.events) {
      const indent = depth > 0 ? '  '.repeat(depth) : '';
      const prefix = depth > 0 ? '├─ ' : '▸ ';
      const latency = ((event.data.latency_ms ?? 0) / 1000).toFixed(1);
      const cost = `$${(event.data.cost_usd ?? 0).toFixed(3)}`;
      const model = event.data.model ?? event.data.child_model ?? '';

      switch (event.event_type) {
        case 'plan_created':
          lines.push(`${indent}▸ plan (${model || 'orchestrator'}, ${cost}, ${latency}s)`);
          break;

        case 'executor_started':
          // Skip — we log the completed event instead
          break;

        case 'executor_completed':
        case 'executor_failed': {
          callCount++;
          const failed = event.event_type === 'executor_failed' ? ' FAILED' : '';
          lines.push(
            `${indent}${prefix}${event.data.executor ?? 'step'}${failed} via ${model} (${cost}, ${latency}s)`
          );
          break;
        }

        case 'child_orchestration_started': {
          depth++;
          const d = event.data.depth ?? depth;
          if (d > maxDepth) maxDepth = d;
          lines.push(
            `${indent}${prefix}sub-orchestrate → ${event.data.child_model ?? 'child'} (depth=${d})`
          );
          break;
        }

        case 'child_orchestration_completed':
        case 'child_orchestration_failed': {
          const childCost = `$${(event.data.child_cost_usd ?? 0).toFixed(3)}`;
          const failed = event.event_type === 'child_orchestration_failed' ? ' FAILED' : '';
          const childIndent = '  '.repeat(depth);
          lines.push(
            `${childIndent}└─ child result${failed} (${event.data.child_model ?? 'child'}, ${childCost}, ${latency}s)`
          );
          depth = Math.max(0, depth - 1);
          break;
        }

        case 'synthesis_completed':
          callCount++;
          lines.push(`${indent}${depth > 0 ? '└─ ' : '▸ '}synthesize (${model || 'orchestrator'}, ${cost}, ${latency}s)`);
          break;

        default:
          break;
      }
    }

    const totalLatency = (trace.total_latency_ms / 1000).toFixed(1);
    const totalCost = trace.total_cost_usd.toFixed(3);

    lines.push(`Σ $${totalCost} · ${totalLatency}s · ${callCount} calls · depth max ${maxDepth}`);

    return lines.join('\n');
  }
}
