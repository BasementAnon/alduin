/**
 * Executor protocol types — the contract between the orchestrator and all executors.
 * The orchestrator emits OrchestratorPlans. Executors receive ExecutorTasks and return ExecutorResults.
 */

/** Orchestration context for recursive multi-model dispatch. */
export interface OrchestrationContext {
  /** Whether this task is allowed to spawn a child orchestrator. Default false. */
  allow_sub_orchestration: boolean;
  /** Maximum recursion depth from root. Default 2, hard cap 4. */
  max_depth: number;
  /** Task ID of the parent that spawned this sub-orchestration. */
  parent_task_id?: string;
  /** Current depth in the recursion tree. 0 at the top level. */
  parent_depth: number;
  /** Parent's remaining cost budget in USD. Child cannot exceed this. */
  parent_budget_remaining_usd: number;
  /** Parent's remaining wall-clock timeout in ms. Child inherits this. */
  parent_timeout_remaining_ms: number;
  /** Model string the parent is running on. Used for affinity checks. */
  parent_model: string;
  /** Allow child to use the same model as parent. Default false. */
  allow_same_model_recursion?: boolean;
}

/** Result metadata from a child sub-orchestration. */
export interface SubOrchestrationResult {
  /** The child orchestrator's root task ID. */
  child_task_id: string;
  /** How many plan steps the child executed. */
  child_steps_executed: number;
  /** Total cost in USD consumed by the child tree. */
  child_cost_usd: number;
  /** Total wall-clock time the child tree took. */
  child_latency_ms: number;
  /** The depth at which the child ran. */
  child_depth: number;
  /** Model the child orchestrator used for planning. */
  child_model: string;
}

/** A task dispatched to an executor by the orchestrator */
export interface ExecutorTask {
  /** UUID identifying this task */
  id: string;
  /** Matches a key in config.executors */
  executor_name: string;
  /** Natural language instruction from the orchestrator */
  instruction: string;
  /** Files, context, or relevant info for the task */
  input_data?: string;
  /** Fully-processed attachments from the ingestion pipeline */
  attachments?: import('../channels/adapter.js').AttachmentRef[];
  max_tokens: number;
  /** Timeout for the executor call in milliseconds */
  timeout_ms: number;
  /** Only the tools this task needs — lazy loaded into executor context */
  tools: string[];
  /** How the result should be returned */
  return_format: 'summary' | 'full' | 'file_ref';
  metadata: {
    parent_task_id?: string;
    step_index?: number;
    pipeline_id?: string;
  };
  /** Policy verdict for this task — enforced at dispatch time */
  policy_verdict?: import('../auth/policy.js').PolicyVerdict;
  /** Recursive orchestration context — present when sub-orchestration is possible */
  orchestration?: OrchestrationContext;
}

/** All possible executor result statuses, including recursion-specific ones. */
export type ExecutorResultStatus =
  | 'complete'
  | 'failed'
  | 'timeout'
  | 'budget_exceeded'
  | 'policy_denied'
  | 'recursion_depth_exceeded'
  | 'loop_detected'
  | 'model_affinity_violation';

/** Result returned by an executor after completing (or failing) a task */
export interface ExecutorResult {
  task_id: string;
  executor_name: string;
  status: ExecutorResultStatus;
  /** Always present — max 500 tokens */
  summary: string;
  /** Present only when return_format was 'full' */
  full_output?: string;
  /** File paths produced by the executor */
  artifacts?: string[];
  error?: { type: string; message: string };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    latency_ms: number;
  };
  /** Present when this task spawned a child orchestrator */
  sub_orchestration?: SubOrchestrationResult;
}

/** Hint from the orchestrator that a step should spawn a child orchestrator. */
export interface SubOrchestrateHint {
  /** Model the child orchestrator should use for planning. */
  child_model: string;
  /** How to generate the child's system prompt. */
  child_system_prompt_mode: 'deterministic' | 'llm_assisted';
}

/** A single step in an orchestrator's execution plan */
export interface PlanStep {
  step_index: number;
  /** Executor name from config */
  executor: string;
  /** Self-contained instruction — the executor has no conversation context */
  instruction: string;
  /** Step indices this step depends on */
  depends_on: number[];
  /** Step index to pull input data from */
  input_from?: number;
  estimated_tokens: number;
  /** If set, this step should spawn a child orchestrator on the named model. */
  sub_orchestrate?: SubOrchestrateHint;
}

/** Structured plan emitted by the orchestrator — never free-form text */
export interface OrchestratorPlan {
  /** Short explanation of why this plan was chosen */
  reasoning: string;
  steps: PlanStep[];
  estimated_total_cost: number;
  can_parallelize: boolean;
}

/**
 * JSON Schema representation of OrchestratorPlan.
 * Injected into the orchestrator system prompt so the model knows the exact output format.
 */
export const ORCHESTRATOR_PLAN_SCHEMA = {
  type: 'object',
  required: ['reasoning', 'steps', 'estimated_total_cost', 'can_parallelize'],
  properties: {
    reasoning: {
      type: 'string',
      description:
        'Short explanation of why this plan was chosen. For simple conversational messages, put your reply here and leave steps empty.',
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['step_index', 'executor', 'instruction', 'depends_on', 'estimated_tokens'],
        properties: {
          step_index: { type: 'number', description: 'Zero-based step index' },
          executor: { type: 'string', description: 'Executor name from config' },
          instruction: {
            type: 'string',
            description: 'Self-contained instruction for the executor',
          },
          depends_on: {
            type: 'array',
            items: { type: 'number' },
            description: 'Step indices this step depends on',
          },
          input_from: {
            type: 'number',
            description: 'Step index whose result should be injected as input_data',
          },
          estimated_tokens: {
            type: 'number',
            description: 'Estimated tokens this step will consume',
          },
          sub_orchestrate: {
            type: 'object',
            description:
              'If set, this step spawns a child orchestrator on a different model. Requires allow_sub_orchestration.',
            properties: {
              child_model: {
                type: 'string',
                description: 'Model the child orchestrator should use',
              },
              child_system_prompt_mode: {
                type: 'string',
                enum: ['deterministic', 'llm_assisted'],
                description:
                  'How to generate the child system prompt. deterministic = template, llm_assisted = one extra LLM call',
              },
            },
            required: ['child_model', 'child_system_prompt_mode'],
          },
        },
      },
    },
    estimated_total_cost: { type: 'number', description: 'Estimated total cost in USD' },
    can_parallelize: {
      type: 'boolean',
      description: 'True if any steps have no mutual dependencies',
    },
  },
} as const;
