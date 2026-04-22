import type { LLMMessage } from '../types/llm.js';
import type { ExecutorTask } from './types.js';

const EXECUTOR_SYSTEM_PROMPT =
  'You are executing a specific task. Complete it fully and return your result. ' +
  'Do not ask clarifying questions — work with what you have. Be concise in your response.';

/**
 * Build a minimal, task-scoped message array for an executor.
 * No conversation history. No personality. No memory. Just the job.
 */
export function buildExecutorContext(task: ExecutorTask): LLMMessage[] {
  let userContent = task.instruction;
  if (task.input_data) {
    userContent += '\n\n---\nInput Data:\n' + task.input_data;
  }

  return [
    { role: 'system', content: EXECUTOR_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}
