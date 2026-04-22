import { describe, it, expect } from 'vitest';

import { RecursionGuard, hashInstruction, HARD_DEPTH_CAP, DEFAULT_MAX_DEPTH } from './recursion.js';
import type { PolicyVerdict } from '../auth/policy.js';
import { DEFAULT_POLICY_VERDICT } from '../auth/policy.js';

function makeVerdict(overrides: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return { ...DEFAULT_POLICY_VERDICT, ...overrides };
}

describe('RecursionGuard', () => {
  describe('preCheck()', () => {
    it('allows a valid sub-orchestration', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'ollama/qwen2.5:32b',
        instruction: 'Summarize the document',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: false,
        verdict: makeVerdict(),
      });

      expect(result.allowed).toBe(true);
    });

    it('rejects when policy kill switch is enabled', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'ollama/qwen2.5:32b',
        instruction: 'Summarize the document',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: false,
        verdict: makeVerdict({ recursion_disabled: true }),
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('policy_denied');
      }
    });

    it('rejects when depth exceeds policy max_recursion_depth', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'ollama/qwen2.5:32b',
        instruction: 'Summarize the document',
        parentDepth: 1,
        maxDepth: 4,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: false,
        verdict: makeVerdict({ max_recursion_depth: 1 }),
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('recursion_depth_exceeded');
        expect(result.message).toContain('depth 2');
      }
    });

    it('rejects when depth exceeds task-level maxDepth', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'ollama/qwen2.5:32b',
        instruction: 'Do something',
        parentDepth: 2,
        maxDepth: 2,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('recursion_depth_exceeded');
      }
    });

    it('enforces hard depth cap even when maxDepth is higher', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction: 'Deep recursion',
        parentDepth: HARD_DEPTH_CAP,
        maxDepth: 10, // above hard cap
        parentBudgetRemaining: 1.0,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('recursion_depth_exceeded');
      }
    });

    it('rejects same-model recursion by default', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'anthropic/claude-sonnet-4-6',
        instruction: 'Critic pass',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('model_affinity_violation');
      }
    });

    it('allows same-model recursion when explicitly permitted', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'anthropic/claude-sonnet-4-6',
        childModel: 'anthropic/claude-sonnet-4-6',
        instruction: 'Critic pass',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.50,
        allowSameModelRecursion: true,
      });

      expect(result.allowed).toBe(true);
    });

    it('rejects when budget is exhausted', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction: 'Work',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 0,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('budget_exceeded');
      }
    });

    it('rejects negative budget', () => {
      const guard = new RecursionGuard('turn-1');
      const result = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction: 'Work',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: -0.5,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('budget_exceeded');
      }
    });

    it('detects loops on repeated edge', () => {
      const guard = new RecursionGuard('turn-1');
      const instruction = 'Summarize this document';

      // First attempt should pass
      const first = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction,
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.0,
        allowSameModelRecursion: false,
      });
      expect(first.allowed).toBe(true);

      // Register the edge
      guard.registerEdge('sonnet', 'qwen', instruction);

      // Second attempt with same edge should be detected as loop
      const second = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction,
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.0,
        allowSameModelRecursion: false,
      });

      expect(second.allowed).toBe(false);
      if (!second.allowed) {
        expect(second.reason).toBe('loop_detected');
      }
    });

    it('allows different instructions on same model pair', () => {
      const guard = new RecursionGuard('turn-1');

      guard.registerEdge('sonnet', 'qwen', 'First task');

      const result = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'qwen',
        instruction: 'Completely different task',
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.0,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(true);
    });

    it('allows same instruction on different model pairs', () => {
      const guard = new RecursionGuard('turn-1');
      const instruction = 'Same task';

      guard.registerEdge('sonnet', 'qwen', instruction);

      const result = guard.preCheck({
        parentModel: 'sonnet',
        childModel: 'llama',
        instruction,
        parentDepth: 0,
        maxDepth: DEFAULT_MAX_DEPTH,
        parentBudgetRemaining: 1.0,
        allowSameModelRecursion: false,
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('registerEdge()', () => {
    it('increments edge count', () => {
      const guard = new RecursionGuard('turn-1');
      expect(guard.edgeCount).toBe(0);

      guard.registerEdge('sonnet', 'qwen', 'task');
      expect(guard.edgeCount).toBe(1);

      guard.registerEdge('sonnet', 'llama', 'task');
      expect(guard.edgeCount).toBe(2);
    });
  });
});

describe('hashInstruction()', () => {
  it('produces consistent hashes', () => {
    const h1 = hashInstruction('Summarize this document');
    const h2 = hashInstruction('Summarize this document');
    expect(h1).toBe(h2);
  });

  it('normalizes whitespace', () => {
    const h1 = hashInstruction('Summarize  this   document');
    const h2 = hashInstruction('Summarize this document');
    expect(h1).toBe(h2);
  });

  it('normalizes case', () => {
    const h1 = hashInstruction('SUMMARIZE THIS DOCUMENT');
    const h2 = hashInstruction('summarize this document');
    expect(h1).toBe(h2);
  });

  it('trims whitespace', () => {
    const h1 = hashInstruction('  Summarize this document  ');
    const h2 = hashInstruction('Summarize this document');
    expect(h1).toBe(h2);
  });

  it('returns a 16-character hex string', () => {
    const h = hashInstruction('anything');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different instructions produce different hashes', () => {
    const h1 = hashInstruction('Summarize this document');
    const h2 = hashInstruction('Translate this document');
    expect(h1).not.toBe(h2);
  });
});
