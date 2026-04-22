import { describe, it, expect } from 'vitest';

import { writeChildSystemPrompt } from './prompts.js';

describe('writeChildSystemPrompt()', () => {
  it('returns a deterministic prompt for a frontier child model', () => {
    const prompt = writeChildSystemPrompt(
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-6',
      'Analyze the competitive landscape',
      'deterministic',
    );

    expect(prompt).toContain('sub-orchestrator');
    expect(prompt).toContain('Analyze the competitive landscape');
    expect(prompt).toContain('Delegated Task');
    // Frontier models should not get the strict JSON format block
    expect(prompt).not.toContain('STRICT');
  });

  it('adds strict output format for small/local models', () => {
    const prompt = writeChildSystemPrompt(
      'anthropic/claude-sonnet-4-6',
      'ollama/qwen2.5:7b',
      'Summarize the data',
      'deterministic',
    );

    expect(prompt).toContain('STRICT');
    expect(prompt).toContain('"result"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('Example');
  });

  it('detects small models by pattern', () => {
    const models = [
      'ollama/llama3.2:7b',
      'ollama/phi3:3b',
      'ollama/mistral:7b',
      'mlx/qwen2.5:14b',
    ];

    for (const model of models) {
      const prompt = writeChildSystemPrompt('sonnet', model, 'task', 'deterministic');
      expect(prompt).toContain('STRICT');
    }
  });

  it('returns a meta-prompt in llm_assisted mode', () => {
    const prompt = writeChildSystemPrompt(
      'anthropic/claude-sonnet-4-6',
      'ollama/qwen2.5:7b',
      'Extract key entities',
      'llm_assisted',
    );

    expect(prompt).toContain('prompt engineer');
    expect(prompt).toContain('child orchestrator');
    expect(prompt).toContain('Extract key entities');
    expect(prompt).toContain('smaller/local model');
  });

  it('defaults to deterministic mode', () => {
    const prompt = writeChildSystemPrompt(
      'sonnet',
      'ollama/qwen:7b',
      'Do something',
    );

    // Should produce deterministic output, not a meta-prompt
    expect(prompt).toContain('sub-orchestrator');
    expect(prompt).not.toContain('prompt engineer');
  });
});
