import { z } from 'zod';

/** Model string pattern: word/word (e.g. "anthropic/claude-sonnet-4-6") */
export const modelStringSchema = z
  .string()
  .regex(
    /^\w[\w.-]*\/[\w][\w.-]*$/,
    'Model string must be in "provider/model-name" format (e.g. "anthropic/claude-sonnet-4-6")'
  );

export const executorContextSchema = z.enum([
  'task_only',
  'task_plus_style_guide',
  'message_only',
]);

/** Context strategy for how an executor receives input. */
export type ExecutorContext = z.output<typeof executorContextSchema>;

export const executorConfigSchema = z.object({
  /** Fully-qualified model string, e.g. "anthropic/claude-sonnet-4-6" */
  model: modelStringSchema,
  max_tokens: z.number().positive('max_tokens must be a positive number'),
  tools: z.array(z.string()).default([]),
  context: executorContextSchema,
  /**
   * Per-request SDK timeout in ms (default 60_000 = 60s).
   * Overrides the SDK default of 10 minutes to prevent runaway requests.
   */
  request_timeout_ms: z.number().int().positive().optional(),
});

/** Configuration for a single executor (code, research, content, etc.) */
export type ExecutorConfig = z.output<typeof executorConfigSchema>;

export const orchestratorConfigSchema = z.object({
  model: modelStringSchema,
  max_planning_tokens: z.number().positive('max_planning_tokens must be a positive number'),
  context_strategy: z.string(),
  context_window: z.number().positive('context_window must be a positive number'),
});

/** Configuration for the orchestrator model. */
export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;

/**
 * Ordered fallback chains: model string → list of fallback model strings.
 * When a model fails, the first available fallback is tried in order.
 */
export const fallbacksSchema = z
  .record(z.string(), z.array(z.string()))
  .optional();

export type FallbacksConfig = z.output<typeof fallbacksSchema>;
