/**
 * Recursion guard — depth tracking, loop detection, and budget
 * pre-checks for recursive multi-model orchestration.
 *
 * One RecursionGuard instance is created per user turn (per
 * processMessage() call) and threaded through the call tree.
 * When the turn completes, the guard is discarded.
 *
 * @see docs/design/recursive-orchestration.md
 * @see docs/ARCHITECTURE.md §3
 */

import { createHash } from 'node:crypto';
import type { PolicyVerdict } from '../auth/policy.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Absolute hard cap on recursion depth. Not configurable. */
export const HARD_DEPTH_CAP = 4;

/** Default max depth when not overridden by policy or task config. */
export const DEFAULT_MAX_DEPTH = 2;

// ── Types ────────────────────────────────────────────────────────────────────

export type RecursionDenialReason =
  | 'recursion_depth_exceeded'
  | 'loop_detected'
  | 'model_affinity_violation'
  | 'budget_exceeded'
  | 'policy_denied';

export type RecursionVerdict =
  | { allowed: true }
  | { allowed: false; reason: RecursionDenialReason; message: string };

export interface RecursionPreCheckOpts {
  parentModel: string;
  childModel: string;
  instruction: string;
  parentDepth: number;
  maxDepth: number;
  parentBudgetRemaining: number;
  allowSameModelRecursion: boolean;
  verdict?: PolicyVerdict;
}

// ── RecursionGuard ───────────────────────────────────────────────────────────

/**
 * Turn-scoped guard for recursive sub-orchestration.
 *
 * Tracks edges within a single user turn to detect loops.
 * All state is discarded when the turn completes.
 */
export class RecursionGuard {
  /** Turn identifier for tracing. */
  readonly turnId: string;

  /**
   * Edge set: key = "parentModel|childModel|instructionHash",
   * value = attempt count. Second attempt triggers loop detection.
   */
  private edges = new Map<string, number>();

  constructor(turnId: string) {
    this.turnId = turnId;
  }

  /**
   * Run all pre-checks for a sub-orchestration attempt.
   * Returns a verdict indicating whether the recursion is allowed.
   *
   * Check order:
   *  1. Policy kill switch
   *  2. Policy depth override
   *  3. Depth cap (task-level and hard cap)
   *  4. Model affinity
   *  5. Budget
   *  6. Loop detection
   */
  preCheck(opts: RecursionPreCheckOpts): RecursionVerdict {
    const {
      parentModel,
      childModel,
      instruction,
      parentDepth,
      maxDepth,
      parentBudgetRemaining,
      allowSameModelRecursion,
      verdict,
    } = opts;

    const childDepth = parentDepth + 1;

    // 1. Policy kill switch
    if (verdict?.recursion_disabled) {
      return {
        allowed: false,
        reason: 'policy_denied',
        message: 'Sub-orchestration is disabled for this session.',
      };
    }

    // 2. Policy depth override
    if (verdict?.max_recursion_depth !== undefined && verdict.max_recursion_depth !== null) {
      if (childDepth > verdict.max_recursion_depth) {
        return {
          allowed: false,
          reason: 'recursion_depth_exceeded',
          message: `Policy limits recursion to depth ${verdict.max_recursion_depth}, but this would be depth ${childDepth}.`,
        };
      }
    }

    // 3. Depth cap (task-level and hard cap)
    const effectiveMax = Math.min(maxDepth, HARD_DEPTH_CAP);
    if (childDepth > effectiveMax) {
      return {
        allowed: false,
        reason: 'recursion_depth_exceeded',
        message: `Recursion depth ${childDepth} exceeds maximum ${effectiveMax}.`,
      };
    }

    // 4. Model affinity
    if (childModel === parentModel && !allowSameModelRecursion) {
      return {
        allowed: false,
        reason: 'model_affinity_violation',
        message: `Sub-orchestration requires a different model than the parent (${parentModel}). Set allow_same_model_recursion to override.`,
      };
    }

    // 5. Budget
    if (parentBudgetRemaining <= 0) {
      return {
        allowed: false,
        reason: 'budget_exceeded',
        message: `No budget remaining for sub-orchestration (remaining: $${parentBudgetRemaining.toFixed(4)}).`,
      };
    }

    // 6. Loop detection
    const hash = hashInstruction(instruction);
    const edgeKey = `${parentModel}|${childModel}|${hash}`;
    const attempts = this.edges.get(edgeKey) ?? 0;

    if (attempts > 0) {
      return {
        allowed: false,
        reason: 'loop_detected',
        message: `Recursive loop detected: ${parentModel} → ${childModel} with the same instruction was already attempted this turn.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Register an edge after a successful pre-check.
   * Must be called before dispatching the child orchestrator.
   */
  registerEdge(parentModel: string, childModel: string, instruction: string): void {
    const hash = hashInstruction(instruction);
    const edgeKey = `${parentModel}|${childModel}|${hash}`;
    const current = this.edges.get(edgeKey) ?? 0;
    this.edges.set(edgeKey, current + 1);
  }

  /** Number of edges registered this turn (for diagnostics). */
  get edgeCount(): number {
    return this.edges.size;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Hash an instruction string for loop detection.
 *
 * Normalization: trim, collapse whitespace, lowercase.
 * Returns first 16 hex chars of SHA-256 for compactness.
 */
export function hashInstruction(instruction: string): string {
  const normalized = instruction.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
