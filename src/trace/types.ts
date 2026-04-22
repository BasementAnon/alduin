import type { OrchestratorPlan } from '../executor/types.js';

/** Event types tracked during a task's lifecycle */
export type TraceEventType =
  | 'plan_created'
  | 'executor_started'
  | 'executor_completed'
  | 'executor_failed'
  | 'synthesis_completed'
  | 'budget_warning'
  | 'budget_exceeded'
  | 'child_orchestration_started'
  | 'child_orchestration_completed'
  | 'child_orchestration_failed'
  | 'tool_invoked'
  | 'tool_completed'
  | 'tool_denied'
  | 'tool_failed';

/** Data payload for a trace event */
export interface TraceEventData {
  model?: string;
  executor?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  latency_ms?: number;
  plan?: OrchestratorPlan;
  result_summary?: string;
  error?: string;
  /** Tool-invocation fields */
  tool_name?: string;
  tool_plugin_id?: string;
  tool_call_id?: string;
  tool_output?: string;
  /** Recursion-specific fields */
  parent_task_id?: string;
  depth?: number;
  child_task_id?: string;
  child_model?: string;
  child_cost_usd?: number;
  reason?: string;
}

/** A single event in a task's trace */
export interface TraceEvent {
  task_id: string;
  timestamp: Date;
  event_type: TraceEventType;
  data: TraceEventData;
}

/** Complete trace for a single user request through the system */
export interface TaskTrace {
  task_id: string;
  user_message: string;
  started_at: Date;
  completed_at?: Date;
  events: TraceEvent[];
  total_cost_usd: number;
  total_tokens: { input: number; output: number };
  total_latency_ms: number;
}
