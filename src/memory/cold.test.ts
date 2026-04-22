import { describe, it, expect, beforeEach } from 'vitest';
import { ColdMemory } from './cold.js';
import type { AlduinConfig } from '../config/types.js';

const testConfig: AlduinConfig = {
  orchestrator: {
    model: 'anthropic/claude-sonnet-4-6',
    max_planning_tokens: 4000,
    context_strategy: 'sliding_window',
    context_window: 16000,
  },
  executors: {},
  providers: {},
  routing: { pre_classifier: false, classifier_model: 'classifier', complexity_threshold: 0.6 },
  budgets: { daily_limit_usd: 10, per_task_limit_usd: 2, warning_threshold: 0.8 },
  memory: {
    hot_turns: 3,
    warm_max_tokens: 500,
    cold_enabled: true,
    cold_similarity_threshold: 0.1, // low threshold so bag-of-words tests pass
  },
};

describe('ColdMemory', () => {
  let cold: ColdMemory;

  beforeEach(() => {
    cold = new ColdMemory(null, testConfig);
  });

  it('stores entries and reports correct size', () => {
    cold.store('s1', 'We discussed TypeScript generics and best practices.', {
      date: new Date(),
      topics: ['typescript', 'generics'],
    });
    expect(cold.size()).toBe(1);
    cold.store('s2', 'User asked about React hooks and state management.', {
      date: new Date(),
      topics: ['react', 'hooks'],
    });
    expect(cold.size()).toBe(2);
  });

  it('returns empty array from an empty store', () => {
    expect(cold.search('TypeScript')).toHaveLength(0);
  });

  it('retrieves stored entries by similarity', () => {
    cold.store('s1', 'We discussed TypeScript generics and best practices.', {
      date: new Date(),
      topics: ['typescript'],
    });
    cold.store('s2', 'User asked about cooking recipes for pasta.', {
      date: new Date(),
      topics: ['cooking'],
    });

    const results = cold.search('TypeScript best practices');
    expect(results.length).toBeGreaterThan(0);
    // The TypeScript entry should rank higher than the cooking one
    expect(results[0]!.sessionId).toBe('s1');
  });

  it('returns results sorted by similarity descending', () => {
    cold.store('s1', 'TypeScript advanced patterns generics utility types', {
      date: new Date(),
      topics: ['typescript'],
    });
    cold.store('s2', 'TypeScript basics', { date: new Date(), topics: ['typescript'] });

    const results = cold.search('TypeScript advanced generics');
    if (results.length >= 2) {
      expect(results[0]!.similarity).toBeGreaterThanOrEqual(results[1]!.similarity);
    }
  });

  it('filters results below similarity threshold', () => {
    const strict = new ColdMemory(null, {
      ...testConfig,
      memory: { ...testConfig.memory!, cold_similarity_threshold: 0.99 },
    });
    strict.store('s1', 'completely unrelated content about pasta', {
      date: new Date(),
      topics: [],
    });
    const results = strict.search('TypeScript programming language');
    expect(results).toHaveLength(0);
  });

  it('respects topK limit', () => {
    for (let i = 0; i < 5; i++) {
      cold.store(`s${i}`, `TypeScript session ${i} about generics and types`, {
        date: new Date(),
        topics: ['typescript'],
      });
    }
    const results = cold.search('TypeScript generics', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('delete removes an entry', () => {
    cold.store('s1', 'First session content', { date: new Date(), topics: [] });
    cold.store('s2', 'Second session content', { date: new Date(), topics: [] });
    cold.delete('s1');
    expect(cold.size()).toBe(1);
  });

  it('cosineSimilarity of identical vectors is 1', () => {
    const v = [1, 2, 3];
    expect(cold.cosineSimilarity(v, v)).toBeCloseTo(1);
  });

  it('cosineSimilarity of orthogonal vectors is 0', () => {
    expect(cold.cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it('cosineSimilarity of zero vectors returns 0', () => {
    expect(cold.cosineSimilarity([], [])).toBe(0);
    expect(cold.cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
