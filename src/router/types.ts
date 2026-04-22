/**
 * Types for the pre-classifier routing layer.
 * The classifier sees ONLY the user's message — no history, no tools, no system prompt bloat.
 */

/** Complexity of the user's request */
export type MessageComplexity = 'low' | 'medium' | 'high';

/** Semantic category of the user's request */
export type MessageCategory =
  | 'code'
  | 'research'
  | 'content'
  | 'ops'
  | 'conversation'
  | 'multi_step';

/**
 * Output of the pre-classifier for a single user message.
 * Used by the Router to decide whether to skip the orchestrator.
 */
export interface ClassificationResult {
  complexity: MessageComplexity;
  category: MessageCategory;
  /** Executor name from config to route to directly, or null if orchestrator should plan */
  suggested_executor: string | null;
  /** When true, the full orchestrator planning loop is required */
  needs_orchestrator: boolean;
  /** 0–1 confidence in this classification */
  confidence: number;
  /** One sentence explaining the classification */
  reasoning: string;
}
