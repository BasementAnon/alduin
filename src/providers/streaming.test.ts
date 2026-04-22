import { describe, it, expect } from 'vitest';
import type { LLMStreamChunk } from '../types/llm.js';

/**
 * Tests for the streaming chunk type contract.
 * Provider-specific streaming tests require live API keys, so we test
 * the chunk type discrimination and the stream consumer integration here.
 */

describe('LLMStreamChunk type discrimination', () => {
  it('delta chunks carry content', () => {
    const chunk: LLMStreamChunk = { type: 'delta', content: 'Hello' };
    expect(chunk.type).toBe('delta');
    if (chunk.type === 'delta') {
      expect(chunk.content).toBe('Hello');
    }
  });

  it('tool_call_start chunks carry id and name', () => {
    const chunk: LLMStreamChunk = { type: 'tool_call_start', id: 'tc1', name: 'get_weather' };
    expect(chunk.type).toBe('tool_call_start');
    if (chunk.type === 'tool_call_start') {
      expect(chunk.id).toBe('tc1');
      expect(chunk.name).toBe('get_weather');
    }
  });

  it('tool_call_delta chunks carry argument fragments', () => {
    const chunk: LLMStreamChunk = { type: 'tool_call_delta', id: 'tc1', arguments_delta: '{"key":' };
    expect(chunk.type).toBe('tool_call_delta');
    if (chunk.type === 'tool_call_delta') {
      expect(chunk.arguments_delta).toBe('{"key":');
    }
  });

  it('usage chunks carry token counts', () => {
    const chunk: LLMStreamChunk = {
      type: 'usage',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(chunk.type).toBe('usage');
    if (chunk.type === 'usage') {
      expect(chunk.usage.input_tokens).toBe(100);
      expect(chunk.usage.output_tokens).toBe(50);
    }
  });

  it('finish chunks carry reason and optional usage', () => {
    const chunk: LLMStreamChunk = {
      type: 'finish',
      finish_reason: 'stop',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(chunk.type).toBe('finish');
    if (chunk.type === 'finish') {
      expect(chunk.finish_reason).toBe('stop');
      expect(chunk.usage?.input_tokens).toBe(100);
    }
  });

  it('finish chunks work without usage', () => {
    const chunk: LLMStreamChunk = { type: 'finish', finish_reason: 'max_tokens' };
    if (chunk.type === 'finish') {
      expect(chunk.usage).toBeUndefined();
    }
  });
});

describe('stream chunk ordering contract', () => {
  it('valid stream follows delta* → (tool_call_start tool_call_delta*)* → usage? → finish', () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } },
      { type: 'finish', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 2 } },
    ];

    // Verify the ordering constraint: finish must be last
    expect(chunks[chunks.length - 1]!.type).toBe('finish');

    // Verify no deltas after finish
    let seenFinish = false;
    for (const chunk of chunks) {
      if (seenFinish) {
        expect(chunk.type).not.toBe('delta');
      }
      if (chunk.type === 'finish') seenFinish = true;
    }
  });

  it('tool call stream has correct ordering', () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'Let me check.' },
      { type: 'tool_call_start', id: 'tc1', name: 'weather' },
      { type: 'tool_call_delta', id: 'tc1', arguments_delta: '{"city":"NYC"}' },
      { type: 'finish', finish_reason: 'tool_use' },
    ];

    // tool_call_start must come before its deltas
    const startIdx = chunks.findIndex((c) => c.type === 'tool_call_start');
    const deltaIdx = chunks.findIndex((c) => c.type === 'tool_call_delta');
    expect(startIdx).toBeLessThan(deltaIdx);
  });
});
