import type { ExecutorResult } from '../executor/types.js';

/** Supported step action verbs */
export type PipelineAction =
  | 'implement'
  | 'review'
  | 'test'
  | 'research'
  | 'draft'
  | 'edit'
  | 'refactor';

/** A single step in a deterministic pipeline */
export interface PipelineStep {
  step_index: number;
  /** Executor name from config */
  executor: string;
  /** Verb describing what to do */
  action: PipelineAction;
  /**
   * Template string for the instruction.
   * Use {step_N_result} to reference prior step output.
   * The very first step also receives the pipeline's initialInput prepended.
   */
  instruction_template: string;
  /** Override the executor's default model for this step */
  model_override?: string;
  /** Step indices that must complete before this step runs */
  depends_on: number[];
  output_type: 'file_ref' | 'text' | 'structured';
}

/** A reusable, versioned pipeline definition */
export interface PipelineDefinition {
  id: string;
  name: string;
  steps: PipelineStep[];
  /** Maximum loop iterations (default 1) */
  max_iterations: number;
  /**
   * Field path expression evaluated against step results to stop iteration early.
   * Format: "step_N.keyword" — iteration stops when the keyword appears in step N's output.
   * Example: "step_1.pass"
   */
  stop_condition?: string;
}

/** Live execution state for a running pipeline */
export interface PipelineState {
  pipeline_id: string;
  current_step: number;
  iteration: number;
  step_results: Map<number, ExecutorResult>;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'policy_denied';
  started_at: Date;
  completed_at?: Date;
}
