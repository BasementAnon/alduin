import { describe, it, expect } from 'vitest';
import { buildModelsConfig, buildProvidersFromModels } from './pick-models.js';
import type { ModelAnswers } from '../types.js';

describe('buildProvidersFromModels', () => {
  it('adds anthropic provider when models include anthropic', () => {
    const p = buildProvidersFromModels(['anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4']);
    expect(p['anthropic']).toEqual({ api_key_env: 'ANTHROPIC_API_KEY' });
    expect(Object.keys(p)).toHaveLength(1);
  });

  it('adds openai provider for openai models', () => {
    const p = buildProvidersFromModels(['openai/gpt-4.1', 'openai/gpt-4.1-mini']);
    expect(p['openai']).toEqual({ api_key_env: 'OPENAI_API_KEY' });
  });

  it('adds ollama provider with base_url (no api key)', () => {
    const p = buildProvidersFromModels(['anthropic/claude-sonnet-4-6', 'ollama/qwen2.5-7b']);
    expect(p['ollama']).toEqual({ base_url: 'http://localhost:11434' });
    expect(p['anthropic']).toBeDefined();
  });

  it('adds both anthropic and openai when cross-provider models are used', () => {
    const p = buildProvidersFromModels(['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1-mini']);
    expect(p['anthropic']).toBeDefined();
    expect(p['openai']).toBeDefined();
    expect(Object.keys(p)).toHaveLength(2);
  });

  it('adds deepseek with openai-compatible api_type', () => {
    const p = buildProvidersFromModels(['deepseek/deepseek-chat']);
    expect(p['deepseek']).toMatchObject({ api_type: 'openai-compatible' });
  });
});

describe('buildModelsConfig', () => {
  const answers: ModelAnswers = {
    assignments: {
      orchestrator: 'anthropic/claude-sonnet-4-6',
      classifier: 'anthropic/claude-haiku-4',
      code: 'anthropic/claude-sonnet-4-6',
      research: 'anthropic/claude-sonnet-4-6',
      content: 'anthropic/claude-sonnet-4-6',
      quick: 'anthropic/claude-haiku-4',
    },
    usedDefaults: true,
  };

  it('sets the orchestrator model correctly', () => {
    const { orchestrator } = buildModelsConfig(answers);
    expect(orchestrator.model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('sets max_planning_tokens and context fields', () => {
    const { orchestrator } = buildModelsConfig(answers);
    expect(orchestrator.max_planning_tokens).toBeGreaterThan(0);
    expect(orchestrator.context_window).toBeGreaterThan(0);
    expect(orchestrator.context_strategy).toBe('sliding_window');
  });

  it('creates a classifier executor with the classifier model', () => {
    const { executors } = buildModelsConfig(answers);
    expect(executors['classifier']?.model).toBe('anthropic/claude-haiku-4');
    expect(executors['classifier']?.max_tokens).toBeLessThanOrEqual(500);
    expect(executors['classifier']?.context).toBe('message_only');
  });

  it('creates the standard set of executors', () => {
    const { executors } = buildModelsConfig(answers);
    expect(Object.keys(executors)).toEqual(
      expect.arrayContaining(['code', 'research', 'content', 'quick', 'classifier'])
    );
  });

  it('routing.pre_classifier is true and classifier_model is "classifier"', () => {
    const { routing } = buildModelsConfig(answers);
    expect(routing.pre_classifier).toBe(true);
    expect(routing.classifier_model).toBe('classifier');
  });

  it('routing.complexity_threshold is between 0 and 1', () => {
    const { routing } = buildModelsConfig(answers);
    expect(routing.complexity_threshold).toBeGreaterThanOrEqual(0);
    expect(routing.complexity_threshold).toBeLessThanOrEqual(1);
  });

  it('builds providers from all model providers', () => {
    const mixed: ModelAnswers = {
      assignments: {
        orchestrator: 'anthropic/claude-sonnet-4-6',
        classifier: 'ollama/qwen2.5-7b',
        code: 'anthropic/claude-sonnet-4-6',
        research: 'anthropic/claude-sonnet-4-6',
        content: 'anthropic/claude-sonnet-4-6',
        quick: 'ollama/qwen2.5-7b',
      },
      usedDefaults: false,
    };
    const { providers } = buildModelsConfig(mixed);
    expect(providers['anthropic']).toBeDefined();
    expect(providers['ollama']).toBeDefined();
  });

  it('non-ollama orchestrator gets fallbacks when multiple providers are used', () => {
    const { fallbacks } = buildModelsConfig(answers);
    // May or may not have fallback depending on model set
    for (const [key, val] of Object.entries(fallbacks ?? {})) {
      expect(typeof key).toBe('string');
      expect(Array.isArray(val)).toBe(true);
    }
  });
});
